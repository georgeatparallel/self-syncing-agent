import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  server: {
    // Allow tunneled dev hosts (ngrok / cloudflared) so Linear webhooks
    // can POST through the tunnel into `vite dev`. Subdomain wildcards
    // use Vite's leading-dot syntax — new tunnel sessions re-roll the
    // subdomain, so hard-coding specific hosts would churn.
    allowedHosts: [".ngrok-free.app", ".ngrok.io", ".trycloudflare.com"]
  }
});
