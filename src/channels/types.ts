export type ChannelType = 'whatsapp' | 'telegram' | 'web';

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
  /** Was this a voice message (for voice-to-voice reply) */
  isVoice?: boolean;
  /** Raw platform-specific context for replies */
  raw: unknown;
}

export interface UnifiedReply {
  text: string;
  image?: Buffer;
  voice?: Buffer;
  document?: Buffer;
  documentName?: string;
  documentMimetype?: string;
  /** WhatsApp template name (for sending outside 24-hour window) */
  template?: string;
  /** Template language code (default: 'he') */
  templateLanguage?: string;
  /** Template body parameters (positional: {{1}}, {{2}}, ...) */
  templateParams?: string[];
}

export interface ChannelAdapter {
  name: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(original: UnifiedMessage, reply: UnifiedReply): Promise<void>;
  sendTyping?(original: UnifiedMessage): Promise<void>;
  /** Send initial text and return message ID for streaming edits */
  sendStreamStart?(original: UnifiedMessage, text: string): Promise<number | null>;
  /** Edit a previously sent message (for streaming) */
  editStreamMessage?(original: UnifiedMessage, messageId: number, text: string): Promise<void>;
  onMessage(handler: (msg: UnifiedMessage) => void): void;
  /** Get webhook handler (for cloud mode) */
  getWebhookHandler?(): (req: any, res: any) => void;
}
