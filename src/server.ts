import type { Server } from 'bun';
import { clone } from './clone';
import * as path from 'path';

const server = Bun.serve({
  async fetch(req: Request, server: Server) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/api/clone') {
      try {
        const body = await req.json();
        const siteUrl = body.url;

        if (!siteUrl) {
          return new Response("URL parameter is required", { status: 400 });
        }

        console.log(`Starting clone for: ${siteUrl}`);
        
        const zipContent = await clone(siteUrl, (progress) => {
          console.log(`Cloning progress: ${Math.round(progress * 100)}%`);
        });

        const safeHostname = new URL(siteUrl).hostname.replace(/[^a-z0-9]/gi, '_');

        return new Response(zipContent, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${safeHostname}_clone.zip"`,
          },
        });

      } catch (error) {
        console.error("Cloning process failed:", error);
        return new Response(
          JSON.stringify({ error: "Failed to clone website." }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Serve static files from 'public' directory
    const filePath = url.pathname === '/' ? 'index.html' : url.pathname;
    const fullPath = path.join(process.cwd(), 'public', filePath);
    
    const file = Bun.file(fullPath);
    if (await file.exists()) {
        return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
  error(error: Error) {
    console.error("Server error:", error);
    return new Response("An unexpected error occurred.", { status: 500 });
  },
});

console.log(`Server listening on http://localhost:${server.port}`); 