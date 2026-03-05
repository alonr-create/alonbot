export type ChannelType = 'whatsapp' | 'telegram';

export interface UnifiedMessage {
  id: string;
  channel: ChannelType;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  /** Base64 image data if image was sent */
  image?: string;
  /** Raw platform-specific context for replies */
  raw: unknown;
}

export interface UnifiedReply {
  text: string;
  image?: Buffer;
}

export interface ChannelAdapter {
  name: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(original: UnifiedMessage, reply: UnifiedReply): Promise<void>;
  onMessage(handler: (msg: UnifiedMessage) => void): void;
}
