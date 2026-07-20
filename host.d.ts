declare module "@code-yeongyu/senpi" {
export interface ExtensionContext {
cwd: string;
hasUI: boolean;
model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, model: string): unknown;
      getApiKeyAndHeaders(model: unknown): Promise<
        | { ok: true; apiKey: string; headers?: Record<string, string>; env?: Record<string, string> }
        | { ok: false; error: string }
      >;
    };
ui: {
notify(message: string, level?: "info" | "warning" | "error"): void;
confirm(title: string, message: string): Promise<boolean>;
};
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => unknown;
      },
    ): void;
  }
}

declare module "@earendil-works/pi-ai/compat" {
  export interface UserMessage {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  }

  export function complete(
    model: unknown,
    context: { systemPrompt: string; messages: UserMessage[] },
    options: {
      apiKey: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    },
  ): Promise<{ content: unknown[] }>;
}
