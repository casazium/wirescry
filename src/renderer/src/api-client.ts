import {
  API_PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ClientCommand,
  type ServerMessage,
} from '../../shared/api';
import type { BackendConnection } from '../../shared/ipc';

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type Command = DistributiveOmit<ClientCommand, 'id'>;

/** Talks to the backend's local API over a WebSocket. */
export class ApiClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    connection: BackendConnection,
    onMessage: (message: ServerMessage) => void,
    onClose: () => void,
  ) {
    this.socket = new WebSocket(connection.apiUrl, [
      API_PROTOCOL,
      `${TOKEN_PROTOCOL_PREFIX}${connection.token}`,
    ]);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === 'result') {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.ok) pending?.resolve(message.value);
        else pending?.reject(new Error(message.error));
        return;
      }
      onMessage(message);
    });
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Disconnected'));
      this.pending.clear();
      onClose();
    });
  }

  send(command: Command): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ ...command, id }));
    });
  }

  close(): void {
    this.socket.close();
  }
}
