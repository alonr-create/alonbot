import { EventEmitter } from 'events';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

let currentQR: string | null = null;
let connectionStatus: ConnectionStatus = 'disconnected';

/**
 * EventEmitter for QR/connection state changes.
 * Emits 'qr' with data URL when new QR available.
 * Emits 'status' with ConnectionStatus on status change.
 */
export const qrEvents = new EventEmitter();

export function setQR(dataUrl: string): void {
  currentQR = dataUrl;
  qrEvents.emit('qr', dataUrl);
}

export function clearQR(): void {
  currentQR = null;
  qrEvents.emit('qr', null);
}

export function getCurrentQR(): string | null {
  return currentQR;
}

export function setConnectionStatus(status: ConnectionStatus): void {
  connectionStatus = status;
  qrEvents.emit('status', status);
}

export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}
