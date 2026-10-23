interface Subscription {
  subject: string;
  method: string;
}

export interface Handler {
  stream: string;
  subject: string;
  handle: (data: any) => unknown;
}

const streams = new WeakMap<Function, string>();
const subscriptions = new WeakMap<Function, Subscription[]>();

/**
 * Mark a class as handling messages from `name`. Its `@subscribe` methods
 * receive the stream's messages.
 * @param name the stream, e.g. `transactions`
 */
export function stream(name: string): ClassDecorator {
  return target => {
    streams.set(target, name);
  };
}

/**
 * Handle messages on a subject under the class's stream. The method gets the
 * decoded message; returning acks it, throwing has it redelivered.
 * @param subject subject after the stream name, wildcards allowed, e.g. `credit.*`
 */
export function subscribe(subject: string): MethodDecorator {
  return (prototype, method) => {
    const list = subscriptions.get(prototype.constructor) ?? [];
    list.push({ subject, method: String(method) });
    subscriptions.set(prototype.constructor, list);
  };
}

/**
 * The handlers an instance of a `@stream` class provides, bound to it.
 */
export function handlersOf(instance: object): Handler[] {
  const constructor = instance.constructor;
  const name = streams.get(constructor);
  if (!name) {
    throw new Error(`${constructor.name} has no @stream decorator`);
  }

  return (subscriptions.get(constructor) ?? []).map(({ subject, method }) => ({
    stream: name,
    subject,
    handle: (data: any) => instance[method](data)
  }));
}
