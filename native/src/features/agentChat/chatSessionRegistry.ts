import { ChatSession, type ChatTransport } from './chatSession';

/** Delivery identity belongs to the saved host profile, not its replaceable socket. */
export class ChatSessionRegistry<Client extends object> {
  private readonly hosts = new Map<string, Map<string, { client: Client; session: ChatSession }>>();
  constructor(private readonly transportFor: (client: Client) => ChatTransport) {}

  forPanel(hostId: string, panelId: string, client: Client): ChatSession {
    let panels = this.hosts.get(hostId);
    if (!panels) { panels = new Map(); this.hosts.set(hostId, panels); }
    let binding = panels.get(panelId);
    if (!binding) {
      binding = { client, session: new ChatSession(panelId, this.transportFor(client)) };
      panels.set(panelId, binding);
    } else if (binding.client !== client) {
      binding.session.rebind(this.transportFor(client));
      binding.client = client;
    }
    return binding.session;
  }
}
