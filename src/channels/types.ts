export type ChannelType = 'whatsapp' | 'telegram';

export interface UnifiedMessage {
  id: string;
  channel: ChannelType;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  /** Base64 image data */
  image?: string;
  /** MIME type of the image (e.g. image/jpeg, image/png, image/webp) */
  imageMediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Base64 PDF/document data */
  document?: string;
  /** Original filename of the document */
  documentName?: string;
  /** Raw platform-specific context for replies */
  raw: unknown;
}

export interface UnifiedReply {
  text: string;
  image?: Buffer;
  voice?: Buffer;
}

export interface ChannelAdapter {
  name: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(original: UnifiedMessage, reply: UnifiedReply): Promise<void>;
  sendTyping?(original: UnifiedMessage): Promise<void>;
  onMessage(handler: (msg: UnifiedMessage) => void): void;
}
