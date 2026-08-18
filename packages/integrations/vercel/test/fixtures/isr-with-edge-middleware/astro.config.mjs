import vercel from "@astrojs/vercel";
import { defineConfig } from "astro/config";

export default defineConfig({
	adapter: vercel({
		middlewareMode: 'edge',
		isr: {
			bypassToken: "test-token-123",
			expiration: 120,
			exclude: ["/excluded"],
		},
	}),
	output: 'server',
});
