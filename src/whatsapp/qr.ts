import { EventEmitter } from 'events';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

let currentQR: string | null = null;
let currentPairingCode: string | null = null;
let connectionStatus: ConnectionStatus = 'disconnected';

export const qrEvents = new EventEmitter();

export function setQR(dataUrl: string): void {
  currentQR = dataUrl;
  qrEvents.emit('qr', dataUrl);
}

export function clearQR(): void {
  currentQR = null;
  currentPairingCode = null;
  qrEvents.emit('qr', null);
}

export function getCurrentQR(): string | null {
  return currentQR;
}

export function setPairingCode(code: string): void {
  currentPairingCode = code;
  qrEvents.emit('pairing-code', code);
}

export function getPairingCode(): string | null {
  return currentPairingCode;
}

export function setConnectionStatus(status: ConnectionStatus): void {
  connectionStatus = status;
  qrEvents.emit('status', status);
}

export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}
