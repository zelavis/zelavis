declare const Bun: {
  env: Record<string, string | undefined>;
  serve(options: {
    port?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): {
    stop(closeActiveConnections?: boolean): void;
  };
};
