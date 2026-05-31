type Listener = (event: string, data: unknown) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: string, data: unknown) {
    for (const listener of this.listeners) {
      listener(event, data);
    }
  }
}
