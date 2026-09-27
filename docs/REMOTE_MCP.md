# Remote MCP

The included launcher is for local development only and binds Runner MCP to `127.0.0.1:7678`.

For remote access, keep the service loopback-bound behind HTTPS and strong authentication. Configure your own public base URL and OAuth/resource settings with environment variables. Never expose `auth=none` to the public Internet.
