import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import sharp from 'sharp';
import { ImageContextError, type ContentPart } from './ai-context.js';
import { beginProgress, type ProgressReporter } from './progress.js';

const MAX_DOWNLOAD = 10 * 1024 * 1024;
const MAX_NORMALIZED = 4 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
const privateV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateV4.addSubnet(network, prefix, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const reservedV6 = new BlockList();
reservedV6.addSubnet('2001:db8::', 32, 'ipv6');
reservedV6.addSubnet('2001::', 23, 'ipv6');
reservedV6.addSubnet('2002::', 16, 'ipv6');
export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !privateV4.check(address, 'ipv4')
    : family === 6 && publicV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6');
}
export function validateQqImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageContextError('QQ 图片地址无效。');
  }
  const domains = ['qq.com', 'qq.com.cn', 'qpic.cn', 'qlogo.cn', 'gtimg.cn', 'gtimg.com'];
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    value.length > 8192 ||
    !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  ) {
    throw new ImageContextError(
      '图片下载仅允许 QQ 公网图片域名及默认 HTTP(S) 端口，不读取本地或其他服务地址。',
    );
  }
  return url;
}
// Resolve and validate at the actual socket connection, avoiding a separate DNS check/fetch race.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const first = addresses[0];
    if (!first || addresses.some((address) => !isPublicImageAddress(address.address))) {
      callback(new Error('QQ 图片域名解析到非公网地址'), []);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};
export async function downloadQqImage(value: string, signal: AbortSignal): Promise<Buffer> {
  const url = validateQqImageUrl(value);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  requestSignal.throwIfAborted();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method: 'GET',
          signal: requestSignal,
          lookup: publicLookup,
          agent: false,
          headers: { Accept: 'image/*' },
        },
        (response) => {
          void (async () => {
            try {
              if (response.statusCode !== 200)
                throw new ImageContextError(
                  `QQ 图片下载返回 HTTP ${response.statusCode ?? '未知'}（不跟随重定向），请重新读取图片。`,
                );
              if (Number(response.headers['content-length'] ?? 0) > MAX_DOWNLOAD)
                throw new ImageContextError('QQ 图片超过单张 10 MiB 下载限制。');
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const value of response) {
                const chunk: unknown = value;
                if (!Buffer.isBuffer(chunk)) throw new ImageContextError('QQ 图片返回了无效数据。');
                size += chunk.length;
                if (size > MAX_DOWNLOAD)
                  throw new ImageContextError('QQ 图片超过单张 10 MiB 下载限制。');
                chunks.push(chunk);
              }
              requestSignal.throwIfAborted();
              resolve(Buffer.concat(chunks));
            } catch (error) {
              reject(error);
            } finally {
              response.destroy();
            }
          })();
        },
      );
      request.once('error', reject);
      request.end();
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImageContextError) throw error;
    throw new ImageContextError(
      requestSignal.aborted
        ? 'QQ 图片下载超过 10 秒，请重试。'
        : '无法下载 QQ 图片，地址可能已过期或网络不可达。',
    );
  }
}
export interface PreparedImage {
  dataUrl: string;
  bytes: number;
  note?: string;
}
export type ImageLoader = (
  url: string,
  signal: AbortSignal,
  report?: ProgressReporter,
) => Promise<PreparedImage>;

export async function prepareImage(
  url: string,
  signal: AbortSignal,
  report?: ProgressReporter,
  download: (url: string, signal: AbortSignal) => Promise<Buffer> = downloadQqImage,
): Promise<PreparedImage> {
  const downloaded = beginProgress(report, 'tool', '下载 QQ 图片');
  const bytes = await download(url, signal);
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_DOWNLOAD)
    throw new ImageContextError('QQ 图片为空或超过单张 10 MiB 限制。');
  downloaded(`已读取 ${bytes.length} 字节，图片未写入磁盘`);
  const decoded = beginProgress(report, 'tool', '解码并统一图片格式');
  // Reject vector/documents before decoding: only raster media belong to this message boundary.
  const signature = bytes.subarray(0, 12);
  if (
    !(signature[0] === 0xff && signature[1] === 0xd8) &&
    !signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    !signature.toString('ascii').startsWith('GIF8') &&
    !(
      signature.toString('ascii').startsWith('RIFF') && signature.toString('ascii').endsWith('WEBP')
    )
  ) {
    throw new ImageContextError(
      'QQ 图片不是可识别的 JPEG、PNG、WebP 或 GIF；可能返回了过期页面或不支持的文件。',
    );
  }
  const image = sharp(bytes, { pages: 1, limitInputPixels: 40_000_000, failOn: 'error' }).timeout({
    seconds: 5,
  });
  try {
    signal.throwIfAborted();
    const metadata = await image.metadata();
    signal.throwIfAborted();
    const animated = (metadata.pages ?? 1) > 1;
    const normalized = image
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true });
    const mime = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
    const output = await (
      metadata.hasAlpha ? normalized.png() : normalized.jpeg({ quality: 85 })
    ).toBuffer();
    signal.throwIfAborted();
    if (output.length > MAX_NORMALIZED)
      throw new ImageContextError('图片标准化后仍超过单张 4 MiB 限制。');
    const note = animated ? '动图仅分析首帧，未分析完整动画。' : undefined;
    decoded(`${mime}，${output.length} 字节${note ? '；动图已提取首帧' : ''}`);
    return {
      dataUrl: `data:${mime};base64,${output.toString('base64')}`,
      bytes: output.length,
      note,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImageContextError) throw error;
    throw new ImageContextError(
      '图片解码或格式转换失败，文件可能损坏、像素过大或无法在 5 秒内处理。',
    );
  } finally {
    image.destroy();
  }
}

export async function embedImages(
  content: string | ContentPart[],
  signal: AbortSignal,
  report?: ProgressReporter,
  load: ImageLoader = prepareImage,
): Promise<string | ContentPart[]> {
  if (typeof content === 'string') return content;
  const cache = new Map<string, PreparedImage>();
  const result: ContentPart[] = [];
  let total = 0;
  for (const part of content) {
    signal.throwIfAborted();
    if (part.type === 'text') {
      result.push(part);
      continue;
    }
    const url = part.image_url.url;
    let prepared = cache.get(url);
    if (!prepared) {
      prepared = await load(url, signal, report);
      cache.set(url, prepared);
    }
    signal.throwIfAborted();
    total += prepared.bytes;
    if (total > MAX_TOTAL)
      throw new ImageContextError(
        '本次图片标准化后合计超过 12 MiB，未提交 AI 分析，请减少单批图片数量。',
      );
    if (prepared.note)
      result.push({ type: 'text', text: JSON.stringify({ imageProcessing: prepared.note }) });
    result.push({ type: 'image_url', image_url: { url: prepared.dataUrl } });
  }
  return result;
}
