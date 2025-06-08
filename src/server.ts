import type { Server } from 'bun';
import { clone } from './clone';
import * as path from 'path';
import * as fs from 'fs/promises';
import JSZip from 'jszip';

// Global progress tracking
const progressStreams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

function createProgressStream(sessionId: string) {
  const stream = new ReadableStream({
    start(controller) {
      progressStreams.set(sessionId, controller);
    },
    cancel() {
      progressStreams.delete(sessionId);
    }
  });
  return stream;
}

function sendProgress(sessionId: string, data: any) {
  const controller = progressStreams.get(sessionId);
  if (controller) {
    try {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      controller.enqueue(new TextEncoder().encode(message));
      console.log(`📡 Sent progress to ${sessionId}:`, data.message || data.type);
    } catch (error) {
      console.error(`❌ Failed to send progress to ${sessionId}:`, error);
      // Remove failed stream
      progressStreams.delete(sessionId);
    }
  } else {
    console.warn(`⚠️  No stream found for session ${sessionId}`);
  }
}

// Generate UUID function
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Ensure preview directory exists
async function ensurePreviewDir() {
  const previewDir = path.join(process.cwd(), 'preview');
  try {
    await fs.access(previewDir);
  } catch {
    await fs.mkdir(previewDir, { recursive: true });
  }
  return previewDir;
}

// Extract ZIP to preview directory
async function extractToPreview(zipContent: Buffer, uuid: string, basePreviewDir: string): Promise<void> {
  const previewPath = path.join(basePreviewDir, uuid);
  
  // Remove existing directory if it exists
  try {
    await fs.rm(previewPath, { recursive: true, force: true });
  } catch (error) {
    // Directory doesn't exist, which is fine
  }
  
  // Create preview directory
  await fs.mkdir(previewPath, { recursive: true });
  
  // Extract ZIP content
  const zip = new JSZip();
  const zipData = await zip.loadAsync(zipContent);
  
  for (const [filename, file] of Object.entries(zipData.files)) {
    if (!file.dir) {
      const content = await file.async('nodebuffer');
      const filePath = path.join(previewPath, filename);
      
      // Ensure directory exists, handle conflicts
      try {
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });
      } catch (error: any) {
        // If there's a file conflict (file exists where we need a directory)
        if (error.code === 'ENOTDIR' || error.code === 'EEXIST') {
          const dirPath = path.dirname(filePath);
          const conflictPath = dirPath;
          
          // Check if there's a file blocking directory creation
          try {
            const stat = await fs.stat(conflictPath);
            if (stat.isFile()) {
              // Rename the blocking file
              const newPath = conflictPath + '_file';
              await fs.rename(conflictPath, newPath);
              console.log(`🔄 Renamed conflicting file during extraction: ${conflictPath} -> ${newPath}`);
              // Try creating directory again
              await fs.mkdir(dirPath, { recursive: true });
            }
          } catch (statError) {
            // If stat fails, try to create directory anyway
            await fs.mkdir(dirPath, { recursive: true });
          }
        } else {
          throw error;
        }
      }
      
      // Write file (overwrite if exists)
      try {
        await fs.writeFile(filePath, content);
      } catch (writeError: any) {
        if (writeError.code === 'ENOTDIR') {
          // Handle case where parent path is a file
          console.log(`⚠️ Skipping file due to path conflict: ${filename}`);
        } else {
          throw writeError;
        }
      }
    }
  }
  
  console.log(`✅ Extracted preview to: ${previewPath}`);
}

const server = Bun.serve({
  port: 3000,
  idleTimeout: 255, // Maximum allowed timeout for Bun (255 seconds ≈ 4.25 minutes)
  async fetch(req: Request, server: Server) {
    const url = new URL(req.url);

    // Handle main index page
    if (url.pathname === '/') {
      const file = Bun.file('public/index.html');
      return new Response(file);
    }

    // Handle test page
    if (url.pathname === '/test') {
      const file = Bun.file('test-clone.html');
      return new Response(file);
    }

    // Handle misplaced preview asset requests
    // When browser requests /preview/asset.png instead of /preview/{uuid}/asset.png
    if (url.pathname.startsWith('/preview/') && !url.pathname.startsWith('/api/')) {
      const pathParts = url.pathname.split('/');
      
      // Check if this is a direct asset request like /preview/logo.png
      if (pathParts.length === 3) {
        const assetName = pathParts[2];
        if (!assetName) return new Response("Not Found", { status: 404 });
        
        const referer = req.headers.get('referer');
        
        if (referer) {
          const refererUrl = new URL(referer);
          const match = refererUrl.pathname.match(/^\/preview\/([^\/]+)/);
          if (match && match[1]) {
            const uuid = match[1];
            const fullPath = path.join(process.cwd(), 'preview', uuid, assetName);
            
            try {
              const file = Bun.file(fullPath);
              if (await file.exists()) {
                // Set appropriate content type
                const ext = path.extname(assetName);
                const contentTypes: Record<string, string> = {
                  '.js': 'application/javascript',
                  '.css': 'text/css',
                  '.woff2': 'font/woff2',
                  '.woff': 'font/woff',
                  '.ttf': 'font/ttf',
                  '.png': 'image/png',
                  '.jpg': 'image/jpeg',
                  '.jpeg': 'image/jpeg',
                  '.gif': 'image/gif',
                  '.svg': 'image/svg+xml',
                  '.webp': 'image/webp'
                };
                
                const headers: Record<string, string> = {};
                if (contentTypes[ext]) {
                  headers['Content-Type'] = contentTypes[ext];
                }
                
                return new Response(file, { headers });
              }
            } catch (error) {
              console.error(`Error serving preview asset: ${error}`);
            }
          }
        }
      }
      
      // Handle nested paths like /preview/_next/static/...
      if (pathParts.length > 3) {
        const referer = req.headers.get('referer');
        if (referer) {
          const refererUrl = new URL(referer);
          const match = refererUrl.pathname.match(/^\/preview\/([^\/]+)/);
          if (match && match[1]) {
            const uuid = match[1];
            const assetPath = pathParts.slice(2).join('/'); // Remove '/preview'
            const fullPath = path.join(process.cwd(), 'preview', uuid, assetPath);
            
            try {
              const file = Bun.file(fullPath);
              if (await file.exists()) {
                const ext = path.extname(assetPath);
                const contentTypes: Record<string, string> = {
                  '.js': 'application/javascript',
                  '.css': 'text/css',
                  '.woff2': 'font/woff2',
                  '.woff': 'font/woff',
                  '.ttf': 'font/ttf',
                  '.png': 'image/png',
                  '.jpg': 'image/jpeg',
                  '.jpeg': 'image/jpeg',
                  '.gif': 'image/gif',
                  '.svg': 'image/svg+xml',
                  '.webp': 'image/webp'
                };
                
                const headers: Record<string, string> = {};
                if (contentTypes[ext]) {
                  headers['Content-Type'] = contentTypes[ext];
                }
                
                return new Response(file, { headers });
              }
            } catch (error) {
              console.error(`Error serving preview nested asset: ${error}`);
            }
          }
        }
      }
    }

    // Handle preview static files
    if (url.pathname.startsWith('/preview/')) {
      const pathParts = url.pathname.split('/');
      if (pathParts.length >= 3) {
        const uuid = pathParts[2];
        if (!uuid) {
          return new Response("Invalid preview URL", { status: 400 });
        }
        const filePath = pathParts.slice(3).join('/') || 'index.html';
        const fullPath = path.join(process.cwd(), 'preview', uuid, filePath);
        
        try {
          const file = Bun.file(fullPath);
          if (await file.exists()) {
            return new Response(file);
          }
        } catch (error) {
          console.error(`Error serving preview file: ${error}`);
        }
      }
      return new Response("Preview not found", { status: 404 });
    }

    // Handle SSE endpoint for progress updates
    if (req.method === 'GET' && url.pathname === '/api/progress') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response("Session ID is required", { status: 400 });
      }

      const stream = createProgressStream(sessionId);
      
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Cache-Control'
        }
      });
    }

    // Handle clone API with preview option
    if (req.method === 'POST' && url.pathname === '/api/clone') {
      let body: any;
      try {
        body = await req.json();
        const siteUrl = body.url;
        const enablePreview = body.preview || false;
        const sessionId = body.sessionId || generateUUID();

        if (!siteUrl) {
          return new Response("URL parameter is required", { status: 400 });
        }

        console.log(`Starting clone for: ${siteUrl} (Preview: ${enablePreview})`);
        
        // Send initial progress
        sendProgress(sessionId, { 
          type: 'status', 
          message: `Starting clone for: ${siteUrl}`,
          progress: 0 
        });
        
        const zipContent = await clone(siteUrl, (progress, message) => {
          const progressPercent = Math.round(progress * 100);
          console.log(`Cloning progress: ${progressPercent}%`);
          
          sendProgress(sessionId, { 
            type: 'progress', 
            progress: progressPercent,
            message: message || `Cloning progress: ${progressPercent}%`
          });
        });

        const safeHostname = new URL(siteUrl).hostname.replace(/[^a-z0-9]/gi, '_');

        // If preview is enabled, extract to preview directory
        if (enablePreview) {
          sendProgress(sessionId, { 
            type: 'status', 
            message: 'Extracting preview files...',
            progress: 90 
          });
          
          const basePreviewDir = await ensurePreviewDir();
          const uuid = generateUUID();
          await extractToPreview(zipContent, uuid, basePreviewDir);
          
          sendProgress(sessionId, { 
            type: 'complete', 
            message: 'Clone completed successfully!',
            progress: 100,
            previewUrl: `${url.origin}/preview/${uuid}/`,
            downloadUrl: `${url.origin}/api/download/${uuid}`,
            uuid: uuid
          });
          
          // Close the progress stream
          const controller = progressStreams.get(sessionId);
          if (controller) {
            controller.close();
            progressStreams.delete(sessionId);
          }
          
          return new Response(JSON.stringify({
            success: true,
            previewUrl: `${url.origin}/preview/${uuid}/`,
            downloadUrl: `${url.origin}/api/download/${uuid}`,
            uuid: uuid,
            sessionId: sessionId
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          sendProgress(sessionId, { 
            type: 'complete', 
            message: 'Clone completed successfully! Starting download...',
            progress: 100 
          });
          
          // Give a small delay for the message to reach the client
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Close the progress stream
          const controller = progressStreams.get(sessionId);
          if (controller) {
            controller.close();
            progressStreams.delete(sessionId);
          }
          
          // Original download behavior
          return new Response(zipContent, {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="${safeHostname}_clone.zip"`,
            },
          });
        }

      } catch (error) {
        console.error("Cloning process failed:", error);
        
        // Get sessionId from the original request body (already parsed earlier)
        const sessionId = body?.sessionId;
        if (sessionId) {
          sendProgress(sessionId, { 
            type: 'error', 
            message: 'Failed to clone website: ' + (error as Error).message,
            progress: -1 
          });
          
          // Close the progress stream
          const controller = progressStreams.get(sessionId);
          if (controller) {
            controller.close();
            progressStreams.delete(sessionId);
          }
        }
        
        return new Response(
          JSON.stringify({ error: "Failed to clone website: " + (error as Error).message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Handle download API for previewed sites
    if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
      const uuid = url.pathname.split('/')[3];
      if (uuid && typeof uuid === 'string') {
        const previewPath = path.join(process.cwd(), 'preview', uuid);
        try {
          // Check if preview exists
          await fs.access(previewPath);
          
          // Create ZIP from preview directory
          const zip = new JSZip();
          
          async function addDirectoryToZip(dirPath: string, zipPath: string = '') {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
              const fullPath = path.join(dirPath, entry.name);
              const zipEntryPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
              
              if (entry.isDirectory()) {
                await addDirectoryToZip(fullPath, zipEntryPath);
              } else {
                const content = await fs.readFile(fullPath);
                zip.file(zipEntryPath, content);
              }
            }
          }
          
          await addDirectoryToZip(previewPath);
          const zipContent = await zip.generateAsync({ type: 'nodebuffer' });
          
          return new Response(zipContent, {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="preview_${uuid}.zip"`,
            },
          });
          
        } catch (error) {
          console.error(`Error downloading preview ${uuid}:`, error);
          return new Response("Preview not found", { status: 404 });
        }
      }
      return new Response("Invalid download URL", { status: 400 });
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
console.log(`Preview directory: ${path.join(process.cwd(), 'preview')}`); 