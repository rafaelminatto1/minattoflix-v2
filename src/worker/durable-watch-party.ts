/**
 * Cloudflare Durable Object: WatchPartyRoom
 * Powers both:
 * 1) "Watch Party (Assistir Junto)" — multi-user synchronized playback + chat/reactions
 * 2) "Minatto Remote (Controle Remoto da TV pelo Celular)" — control Play/Pause, Seek, Volume,
 *    Dual Audio Track, and Subtitle Track on the living room TV directly from a smartphone!
 */

interface CloudflareWebSocket extends WebSocket {
  accept(): void;
}

declare const WebSocketPair: {
  new (): { 0: CloudflareWebSocket; 1: CloudflareWebSocket };
};

export interface WatchPartyStatePayload {
  roomCode: string;
  mediaItemId: string;
  mediaTitle: string;
  playing: boolean;
  currentTime: number;
  selectedAudioId?: string;
  selectedSubtitleId?: string;
  updatedAt: number;
  participants: number;
}

export class WatchPartyRoom {
  private sessions = new Set<CloudflareWebSocket>();
  private roomState: WatchPartyStatePayload = {
    roomCode: 'SALA',
    mediaItemId: '',
    mediaTitle: '',
    playing: true,
    currentTime: 0,
    updatedAt: Date.now(),
    participants: 0,
  };

  constructor(_state: Record<string, unknown>) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket Upgrade for real-time Watch Party & Remote Control
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sessions.add(server);
      this.roomState.participants = this.sessions.size;

      server.send(
        JSON.stringify({
          type: 'room_state',
          payload: this.roomState,
        })
      );

      this.broadcast({
        type: 'participants_update',
        participants: this.sessions.size,
      });

      server.addEventListener('message', (event: MessageEvent) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type: string;
            roomCode?: string;
            mediaItemId?: string;
            mediaTitle?: string;
            playing?: boolean;
            currentTime?: number;
            selectedAudioId?: string;
            selectedSubtitleId?: string;
            command?: string;
            value?: unknown;
            senderName?: string;
            chatText?: string;
          };

          if (msg.type === 'sync_state') {
            this.roomState = {
              ...this.roomState,
              roomCode: msg.roomCode || this.roomState.roomCode,
              mediaItemId: msg.mediaItemId ?? this.roomState.mediaItemId,
              mediaTitle: msg.mediaTitle ?? this.roomState.mediaTitle,
              playing: msg.playing ?? this.roomState.playing,
              currentTime: typeof msg.currentTime === 'number' ? msg.currentTime : this.roomState.currentTime,
              selectedAudioId: msg.selectedAudioId ?? this.roomState.selectedAudioId,
              selectedSubtitleId: msg.selectedSubtitleId ?? this.roomState.selectedSubtitleId,
              updatedAt: Date.now(),
              participants: this.sessions.size,
            };
            this.broadcast(
              {
                type: 'sync_state',
                payload: this.roomState,
                senderName: msg.senderName || 'Participante',
              },
              server
            );
          } else if (msg.type === 'remote_command') {
            this.broadcast({
              type: 'remote_command',
              command: msg.command,
              value: msg.value,
              senderName: msg.senderName || 'Controle Remoto',
            });
          } else if (msg.type === 'chat') {
            this.broadcast({
              type: 'chat',
              senderName: msg.senderName || 'Convidado',
              chatText: msg.chatText || '',
              timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
            });
          }
        } catch {
          // Ignore malformed WS message
        }
      });

      const cleanup = () => {
        this.sessions.delete(server);
        this.roomState.participants = this.sessions.size;
        this.broadcast({
          type: 'participants_update',
          participants: this.sessions.size,
        });
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit);
    }

    if (url.pathname.endsWith('/state')) {
      return new Response(JSON.stringify(this.roomState), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response('WatchPartyRoom Durable Object Active', { status: 200 });
  }

  private broadcast(data: Record<string, unknown>, exclude?: WebSocket) {
    const serialized = JSON.stringify(data);
    for (const session of this.sessions) {
      if (session !== exclude) {
        try {
          session.send(serialized);
        } catch {
          this.sessions.delete(session);
        }
      }
    }
  }
}
