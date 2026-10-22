import type { ExchangeSummary } from './api';

export type ExchangeType =
  'json' | 'html' | 'js' | 'css' | 'image' | 'font' | 'media' | 'xml' | 'text' | 'other';

const BY_EXTENSION: Record<string, ExchangeType> = {
  json: 'json',
  html: 'html',
  htm: 'html',
  js: 'js',
  mjs: 'js',
  css: 'css',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  ico: 'image',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  mp4: 'media',
  webm: 'media',
  mp3: 'media',
  m3u8: 'media',
  xml: 'xml',
  txt: 'text',
};

function fromMediaType(type: string): ExchangeType | undefined {
  if (type.endsWith('json') || type.endsWith('+json')) return 'json';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.includes('javascript') || type === 'text/ecmascript') return 'js';
  if (type === 'text/css') return 'css';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('font/') || type.includes('font-')) return 'font';
  if (type.startsWith('video/') || type.startsWith('audio/') || type.includes('mpegurl')) return 'media';
  if (type.endsWith('xml') || type.endsWith('+xml')) return 'xml';
  if (type.startsWith('text/')) return 'text';
  return undefined;
}

/** A broad type for the list's Type column and quick filters, from the response type or the URL. */
export function exchangeType(exchange: Pick<ExchangeSummary, 'contentType' | 'path'>): ExchangeType {
  const fromHeader = exchange.contentType ? fromMediaType(exchange.contentType) : undefined;
  if (fromHeader) return fromHeader;
  const extension = /\.([a-z0-9]+)$/i.exec(exchange.path.split(/[?#]/)[0] ?? '')?.[1]?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || 'other';
}
