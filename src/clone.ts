import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import puppeteer from 'puppeteer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as posixPath from 'path/posix';

export async function clone(url: string, progressCallback: (p: number) => void) {
  const browser = await puppeteer.launch({ 
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

  await page.setRequestInterception(true);

  const resources = new Map<string, { buffer: Buffer; contentType: string }>();
  const externalImagesToDownload = new Set<{ url: string; localPath: string }>();

  page.on('request', (request) => {
    const requestUrl = request.url();
    const resourceType = request.resourceType();
    
    // Only block external CDN resources that consistently cause 404s
    // Keep all local site resources (including fonts and images)
    if (requestUrl.includes('is1-ssl.mzstatic.com')) {
      console.log(`Blocking external CDN resource: ${requestUrl}`);
      request.abort();
      return;
    }
    
    // Block Next.js API routes and image optimization that won't work in static mode
    if (requestUrl.includes('/_next/image') || 
        requestUrl.includes('/api/') ||
        requestUrl.includes('/_next/webpack-hmr') ||
        resourceType === 'websocket') {
      console.log(`Blocking Next.js API/dynamic resource: ${requestUrl}`);
      request.abort();
      return;
    }
    
    // Allow all important resource types including fonts and images from the main site
    if (['image', 'stylesheet', 'script', 'font', 'media', 'document'].includes(resourceType)) {
      request.continue();
    } else {
      request.abort();
    }
  });

  page.on('response', async (response) => {
    const requestUrl = response.url();
    const resourceType = response.request().resourceType();

    // Skip data URLs, blob URLs, and other special URLs
    if (requestUrl.startsWith('data:') || 
        requestUrl.startsWith('blob:') || 
        requestUrl.startsWith('javascript:')) {
      return;
    }

    if (['document', 'stylesheet', 'script', 'image', 'font', 'media'].includes(resourceType)) {
      if (response.ok()) {
        try {
          const url = new URL(requestUrl);
          const buffer = await response.buffer();
          const contentType = response.headers()['content-type'] || 'application/octet-stream';
          
          // Properly decode URL components including Next.js dynamic routes
          let pathName = decodeURIComponent(url.pathname.substring(1));
          
          if (url.search) {
            // Keep the search parameters but sanitize them for filesystem
            const searchParam = url.search.length > 200 ? 
              url.search.substring(0, 200) + '_truncated' : url.search;
            pathName += searchParam;
          }
          
          if (pathName === '' || url.pathname === '/') {
            pathName = 'index.html';
          }
          if (pathName.endsWith('/')) {
            pathName += 'index.html';
          }
          
          // Replace problematic characters for filesystem compatibility, but preserve ? in query strings
          // Only replace the problematic characters in path part, handle query separately
          const pathParts = pathName.split('?');
          if (pathParts.length > 1) {
            // Has query string - sanitize path part only, keep ? for query
            if (pathParts[0]) pathParts[0] = pathParts[0].replace(/[<>:"|*]/g, '_');
            // For query part, only replace really problematic characters
            if (pathParts[1]) pathParts[1] = pathParts[1].replace(/[<>:"|*]/g, '_');
            pathName = (pathParts[0] || '') + '?' + (pathParts[1] || '');
          } else {
            // No query string - can replace all problematic characters including ?
            pathName = pathName.replace(/[<>:"|?*]/g, '_');
          }
          
          // Avoid very long filenames that cause filesystem issues
          if (pathName.length > 200) {
            const extension = pathName.split('.').pop() || '';
            const hash = pathName.split('').reduce((a, b) => {
              a = ((a << 5) - a) + b.charCodeAt(0);
              return a & a;
            }, 0);
            pathName = `file_${Math.abs(hash)}.${extension}`;
          }

          if (resources.has(pathName)) {
            return;
          }

          resources.set(pathName, { buffer, contentType });
          console.log(`Downloaded: ${pathName}`);
          
          // Update progress
          const progress = Math.min(resources.size / 50, 0.8); // Rough estimation
          progressCallback(progress);
        } catch (e) {
          console.error(`Failed to download ${requestUrl}: ${e}`);
        }
      }
    }
  });

  try {
    // Navigate to page and wait for initial load
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    
    // Wait additional time for modern frameworks to load dynamic content
    console.log('Waiting for dynamic content to load...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Trigger any lazy loading by scrolling
    await page.evaluate(() => {
      return new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0); // Scroll back to top
            setTimeout(resolve, 1000);
          }
        }, 100);
      });
    });
    
    // Wait for any additional network activity
    await new Promise(resolve => setTimeout(resolve, 2000));
    
  } catch (error) {
    console.error('Failed to navigate to page:', error);
    await browser.close();
    throw error;
  }

  const htmlContent = await page.content();
  
  // Extract and download original images from Next.js optimization URLs
  const $temp = cheerio.load(htmlContent);
  const imagesToDownload: string[] = [];
  
  // Find all Next.js optimized image URLs and extract original paths
  $temp('img[src*="/_next/image"]').each((i, element) => {
    const src = $temp(element).attr('src');
    if (src) {
      try {
        const urlObj = new URL(src, url);
        const originalPath = urlObj.searchParams.get('url');
        if (originalPath) {
          const originalUrl = new URL(originalPath, url).toString();
          imagesToDownload.push(originalUrl);
          console.log(`📸 Found original image to download: ${originalPath}`);
        }
      } catch (e) {
        console.log(`Failed to parse image URL: ${src}`);
      }
    }
  });
  
  // Download the original images
  for (const imageUrl of imagesToDownload) {
    try {
      const response = await fetch(imageUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const parsedUrl = new URL(imageUrl);
        let imagePath = parsedUrl.pathname.substring(1);
        if (!imagePath) imagePath = 'image.jpg';
        
        resources.set(imagePath, { 
          buffer, 
          contentType: response.headers.get('content-type') || 'image/jpeg' 
        });
        console.log(`✅ Downloaded original image: ${imagePath}`);
      }
    } catch (e) {
      console.log(`❌ Failed to download image: ${imageUrl}`);
    }
  }
  
  await browser.close();

  const zip = new JSZip();
  const $ = cheerio.load(htmlContent);

  const baseUrl = url;

  // Update all resource URLs in HTML
  const attributesToUpdate = ['href', 'src', 'poster', 'data-src', 'data-bg', 'data-anim-src'];
  const allElementsSelector = attributesToUpdate.map(attr => `[${attr}]`).join(', ');

  $(allElementsSelector).each((i, element) => {
    const el = $(element);
    for (const attr of attributesToUpdate) {
      const resourceUrl = el.attr(attr);
      if (resourceUrl) {
        // Skip data URLs, blob URLs, and other special URLs
        if (resourceUrl.startsWith('data:') || 
            resourceUrl.startsWith('blob:') || 
            resourceUrl.startsWith('javascript:') ||
            resourceUrl.startsWith('#')) {
          continue;
        }
        
        // Handle Next.js optimized images by replacing with original or placeholder
        if (resourceUrl.includes('/_next/image')) {
          try {
            const urlObj = new URL(resourceUrl, baseUrl);
            const originalPath = urlObj.searchParams.get('url');
            if (originalPath) {
              const cleanPath = originalPath.substring(1); // Remove leading slash
              if (resources.has(cleanPath)) {
                console.log('🖼️ Replacing Next.js image with original:', cleanPath);
                el.attr(attr, cleanPath);
                continue;
              }
            }
          } catch (e) {
            console.log('Failed to parse Next.js image URL:', resourceUrl);
          }
          
          // Fallback to placeholder
          console.log('🖼️ Replacing Next.js image with placeholder:', resourceUrl);
          if (attr === 'src' || attr === 'href') {
            el.attr(attr, 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2RkZCIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlPC90ZXh0Pjwvc3ZnPg==');
            el.css('opacity', '0.5');
          } else {
            el.removeAttr(attr);
          }
          continue;
        }
        
        // Handle other API resources
        if (resourceUrl.includes('/api/') || resourceUrl.includes('gtag/js')) {
          console.log('🗑️ Removing API resource:', resourceUrl);
          if (attr === 'src' || attr === 'href') {
            el.removeAttr(attr);
          } else {
            el.removeAttr(attr);
          }
          continue;
        }
        
        try {
          const absoluteUrl = new URL(resourceUrl, baseUrl);
          // Properly decode URL components including Next.js dynamic routes
          let localPath = decodeURIComponent(absoluteUrl.pathname.substring(1));
          
          if (absoluteUrl.search) {
            const searchParam = absoluteUrl.search.length > 200 ? 
              absoluteUrl.search.substring(0, 200) + '_truncated' : absoluteUrl.search;
            localPath += searchParam;
          }
          
          // Replace problematic characters for filesystem compatibility, but preserve ? in query strings
          const pathParts = localPath.split('?');
          if (pathParts.length > 1) {
            // Has query string - sanitize path part only, keep ? for query
            if (pathParts[0]) pathParts[0] = pathParts[0].replace(/[<>:"|*]/g, '_');
            // For query part, only replace really problematic characters
            if (pathParts[1]) pathParts[1] = pathParts[1].replace(/[<>:"|*]/g, '_');
            localPath = (pathParts[0] || '') + '?' + (pathParts[1] || '');
          } else {
            // No query string - can replace all problematic characters including ?
            localPath = localPath.replace(/[<>:"|?*]/g, '_');
          }
          
          // Create a more robust path matching system
          const findBestMatch = (targetPath: string) => {
            // Try exact match first
            if (resources.has(targetPath)) return targetPath;
            
            // Try URL decoded version
            try {
              const decodedPath = decodeURIComponent(targetPath);
              if (resources.has(decodedPath)) return decodedPath;
            } catch (e) {}
            
            // Try with query parameters stripped
            const pathWithoutQuery = targetPath.split('?')[0] || targetPath;
            if (resources.has(pathWithoutQuery)) return pathWithoutQuery;
            
            // Try finding files that start with the same base path
            for (const [key] of resources) {
              if (key.startsWith(pathWithoutQuery)) {
                return key;
              }
            }
            
            // Try partial matching for complex Next.js paths
            const normalizedTarget = targetPath.replace(/[%\[\]]/g, '');
            for (const [key] of resources) {
              const normalizedKey = key.replace(/[%\[\]]/g, '');
              if (normalizedKey.includes(normalizedTarget) || normalizedTarget.includes(normalizedKey)) {
                return key;
              }
            }
            
            return null;
          };
          
          const matchedPath = findBestMatch(localPath);
          if (matchedPath) {
            el.attr(attr, matchedPath);
          } else {
            // Check if this is an external image that we should download
            if (/^https?:\/\//.test(resourceUrl) && (attr === 'src' || attr === 'href') && 
                (el.is('img') || resourceUrl.match(/\.(jpg|jpeg|png|gif|svg|webp)(\?.*)?$/i))) {
              try {
                const urlObj = new URL(resourceUrl);
                const fileName = posixPath.basename(urlObj.pathname) || 'image';
                const extension = fileName.includes('.') ? '' : '.jpg';
                const localFileName = `external_images/${fileName}${extension}`;
                
                console.log(`📥 Adding external image to download queue: ${resourceUrl}`);
                externalImagesToDownload.add({
                  url: resourceUrl,
                  localPath: localFileName
                });
                
                // Update the attribute to point to the local path
                el.attr(attr, localFileName);
              } catch (e) {
                console.warn(`Failed to process external image URL: ${resourceUrl}`);
                // Log missing resource for debugging
                console.log(`⚠️ Could not find resource: ${localPath} (original: ${resourceUrl})`);
              }
            } else {
              // Log missing resource for debugging
              console.log(`⚠️ Could not find resource: ${localPath} (original: ${resourceUrl})`);
            }
          }
        } catch (e) {
          console.log(`Skipping invalid URL in attribute ${attr}: ${resourceUrl}`);
        }
      }
    }
  });

  // Add Raphael.app specific handling
  if (url.includes('raphael.app')) {
    $('head').append(`
      <script>
// Raphael.app specific fixes
console.log("🎨 Raphael.app specific optimizations loaded");

// Mock the AI image generation functionality for demo purposes
window.mockRaphaelAPI = {
    generateImage: function(prompt) {
        console.log("🎨 Mock image generation for:", prompt);
        return Promise.resolve({
            imageUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiM2MzY2ZjE7c3RvcC1vcGFjaXR5OjEiIC8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdHlsZT0ic3RvcC1jb2xvcjojOGI1Y2Y2O3N0b3Atb3BhY2l0eToxIiAvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSJ1cmwoI2cpIi8+PHRleHQgeD0iMjU2IiB5PSIyNDAiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IndoaXRlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+R2VuZXJhdGVkIEltYWdlPC90ZXh0Pjx0ZXh0IHg9IjI1NiIgeT0iMjgwIiBmb250LXNpemU9IjE2IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPlN0YXRpYyBDbG9uZTwvdGV4dD48L3N2Zz4=',
            success: true
        });
    }
};

// Mock any API calls that might be used for image generation
if (window.fetch) {
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        if (typeof url === 'string' && (url.includes('/api/generate') || url.includes('/generate') || url.includes('replicate.com'))) {
            console.log("🎨 Mocking image generation API call");
            return Promise.resolve(new Response(JSON.stringify({
                imageUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiM2MzY2ZjE7c3RvcC1vcGFjaXR5OjEiIC8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdHlsZT0ic3RvcC1jb2xvcjojOGI1Y2Y2O3N0b3Atb3BhY2l0eToxIiAvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSJ1cmwoI2cpIi8+PHRleHQgeD0iMjU2IiB5PSIyNDAiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IndoaXRlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+R2VuZXJhdGVkIEltYWdlPC90ZXh0Pjx0ZXh0IHg9IjI1NiIgeT0iMjgwIiBmb250LXNpemU9IjE2IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPlN0YXRpYyBDbG9uZTwvdGV4dD48L3N2Zz4=',
                success: true,
                message: 'Static clone - AI generation not available'
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }
        return originalFetch.apply(this, arguments);
    };
}
      </script>
    `);
  }

  // Add enhanced script for static mode with Next.js and modern framework support
  $('head').append(`
    <script>
console.log("🚀 Enhanced static clone script with Next.js support loaded");

if (window.location.protocol === 'file:') {
    console.log("📁 File protocol detected, applying comprehensive fixes...");

    const originalFetch = window.fetch;
    const originalXhrOpen = window.XMLHttpRequest.prototype.open;
    const allowedExtensions = ['.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm', '.ogg', '.webp'];

    function shouldBlockRequest(url) {
        try {
            const urlObj = new URL(url, window.location.href);
            const isApiCall = !allowedExtensions.some(ext => urlObj.pathname.endsWith(ext));
            // Special handling for Next.js image optimization API
            if (urlObj.pathname.includes('/_next/image')) {
                console.log('🖼️ Blocking Next.js image API call:', urlObj.pathname);
                return true;
            }
            if (isApiCall) {
                console.log('🚫 Blocking API call:', urlObj.pathname);
                return true;
            }
        } catch (e) {
            if (!allowedExtensions.some(ext => url.endsWith(ext))) {
                 console.log('🚫 Blocking API call:', url);
                return true;
            }
        }
        return false;
    }

    // Enhanced fetch wrapper with better error handling for Next.js
    window.fetch = function(input, init) {
        const requestUrl = (typeof input === 'string') ? input : input.url;
        if (shouldBlockRequest(requestUrl)) {
            // Return appropriate mock responses for different types of requests
            if (requestUrl.includes('/_next/image')) {
                return Promise.resolve(new Response(new Blob(), {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'image/png' }
                }));
            }
            return Promise.resolve(new Response('{}', {
                status: 200,
                statusText: 'OK',
                headers: { 'Content-Type': 'application/json' }
            }));
        }
        return originalFetch.apply(this, arguments).catch(error => {
            console.warn('🔧 Fetch failed, returning empty response:', error);
            return new Response('{}', {
                status: 200,
                statusText: 'OK',
                headers: { 'Content-Type': 'application/json' }
            });
        });
    };

    // Enhanced XHR wrapper with better error handling  
    window.XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        if (shouldBlockRequest(url)) {
            console.log('🚫 XHR request blocked:', url);
            // Return mock successful response instead of aborting
            setTimeout(() => {
                if (this.onreadystatechange) {
                    Object.defineProperty(this, 'readyState', { value: 4, writable: false });
                    Object.defineProperty(this, 'status', { value: 200, writable: false });
                    Object.defineProperty(this, 'responseText', { value: '{}', writable: false });
                    this.onreadystatechange();
                }
            }, 0);
            return;
        }
        return originalXhrOpen.apply(this, arguments);
    };

    // Enhanced webpack chunk loading with better error recovery for Next.js
    if (typeof window !== 'undefined') {
        // Override __webpack_require__ if available
        if (window.__webpack_require__) {
            const originalRequire = window.__webpack_require__;
            window.__webpack_require__ = function(moduleId) {
                try {
                    return originalRequire(moduleId);
                } catch (e) {
                    console.warn('🔧 Module load failed, returning empty object:', moduleId);
                    return {};
                }
            };
        }

        // Enhanced webpack chunk error handling
        const originalDefine = window.define;
        if (originalDefine) {
            window.define = function(...args) {
                try {
                    return originalDefine.apply(this, args);
                } catch (e) {
                    console.warn('🔧 AMD define failed, continuing:', e);
                }
            };
        }

        // Patch webpack chunk loading with retries and fallbacks
        let webpackJsonp = window.__webpack_require__ && window.__webpack_require__.e;
        if (webpackJsonp) {
            const originalChunkLoad = webpackJsonp;
            window.__webpack_require__.e = function(chunkId) {
                return originalChunkLoad.call(this, chunkId).catch((error) => {
                    console.warn('🔧 Chunk load failed, returning resolved promise:', chunkId, error);
                    return Promise.resolve();
                });
            };
        }

        // Handle Next.js specific globals
        if (typeof window.__NEXT_DATA__ !== 'undefined') {
            console.log('🔍 Next.js app detected, applying specific fixes...');
            
            // Mock Next.js router for static mode
            if (!window.next) {
                window.next = {
                    router: {
                        push: () => Promise.resolve(true),
                        replace: () => Promise.resolve(true),
                        back: () => {},
                        reload: () => window.location.reload(),
                        events: {
                            on: () => {},
                            off: () => {},
                            emit: () => {}
                        }
                    }
                };
            }
            
            // Mock Next.js image optimization
            if (window.Image) {
                const OriginalImage = window.Image;
                window.Image = function(...args) {
                    const img = new OriginalImage(...args);
                    const originalSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
                    
                    Object.defineProperty(img, 'src', {
                        get: originalSrc.get,
                        set: function(value) {
                            // Redirect Next.js optimized images to placeholder or fallback
                            if (value && value.includes('/_next/image')) {
                                console.log('🖼️ Redirecting Next.js optimized image to placeholder');
                                originalSrc.set.call(this, 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2RkZCIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlPC90ZXh0Pjwvc3ZnPg==');
                            } else {
                                originalSrc.set.call(this, value);
                            }
                        }
                    });
                    
                    return img;
                };
            }
        }
    }

    // Handle dynamic imports that might fail
    const originalDynamicImport = window.__dynamicImportHandler__ || (async (url) => import(url));
    window.__dynamicImportHandler__ = async function(url) {
        try {
            return await originalDynamicImport(url);
        } catch (e) {
            console.warn('🔧 Dynamic import failed, returning empty module:', url);
            return { default: () => null };
        }
    };

    // Intercept fetch requests for Next.js images and redirect to error handling
    if (window.fetch) {
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            if (typeof input === 'string' && input.includes('/_next/image')) {
                console.log('🔧 Intercepting Next.js image fetch request:', input);
                // Return a rejected promise to trigger error handling
                return Promise.reject(new Error('Next.js image API not available in static mode'));
            }
            return originalFetch.call(this, input, init);
        };
    }

    document.addEventListener('DOMContentLoaded', () => {
        console.log("🎯 DOM loaded, enhancing interactions...");
        
        // Enable videos with better error handling
        document.querySelectorAll('video').forEach(v => {
            v.muted = true;
            v.play().catch(e => console.warn("Video autoplay prevented:", e));
        });
        
        // Handle missing images gracefully and fix Next.js images
        document.querySelectorAll('img').forEach(img => {
            img.addEventListener('error', function() {
                console.warn('⚠️ Image not found:', this.src);
                if (this.src.includes('/_next/image')) {
                    // Replace with placeholder for Next.js optimized images
                    this.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2RkZCIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlPC90ZXh0Pjwvc3ZnPg==';
                    this.style.opacity = '0.5';
                } else {
                    this.style.display = 'none'; // Hide other broken images
                }
            });
            
            // Preemptively fix Next.js image sources
            if (img.src && img.src.includes('/_next/image')) {
                console.log('🖼️ Converting Next.js optimized image to placeholder');
                img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2RkZCIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlPC90ZXh0Pjwvc3ZnPg==';
                img.style.opacity = '0.5';
            }
        });

        // Enable interactive elements that might be disabled for static mode
        document.querySelectorAll('button, [role="button"], .interactive').forEach(el => {
            el.style.pointerEvents = 'auto';
            el.style.cursor = 'pointer';
        });

        // Enhanced font CORS fixes with better fallbacks
        setTimeout(() => {
            console.log('🔤 Applying enhanced font CORS fixes...');
            const style = document.createElement('style');
            style.textContent = \`
                @font-face {
                    font-family: '__Next_Font_Fallback__';
                    src: local('system-ui'), local('-apple-system'), local('BlinkMacSystemFont');
                    font-display: swap;
                }
                
                /* Apply fallback fonts to all elements */
                *, ::before, ::after {
                    font-family: '__Next_Font_Fallback__', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
                }
                
                /* Override preload link CORS issues */
                link[rel="preload"][as="font"] {
                    display: none !important;
                }
                
                /* Hide broken images and placeholders */
                img[src*="data:"], img[src=""], img[src*="/_next/image"] {
                    opacity: 0.5 !important;
                    background: #f0f0f0 !important;
                    border: 1px dashed #ccc !important;
                }
                
                /* Fix common Next.js layout issues in static mode */
                [data-nextjs-scroll-focus-boundary] {
                    display: contents !important;
                }
                
                /* Ensure text remains visible during font loading */
                body {
                    font-display: swap !important;
                }
            \`;
            document.head.appendChild(style);
        }, 100);

        // Enhanced error suppression for React/Next.js chunk loading
        window.addEventListener('error', (event) => {
            const errorMessage = event.message || '';
            if (errorMessage.includes('ChunkLoadError') || 
                errorMessage.includes('Loading chunk') ||
                errorMessage.includes('Minified React error') ||
                errorMessage.includes('Loading CSS chunk') ||
                errorMessage.includes('ERR_FILE_NOT_FOUND') ||
                errorMessage.includes('/_next/image') ||
                errorMessage.includes('Cannot read properties of undefined')) {
                console.warn('🔧 Suppressing React/Next.js error:', errorMessage);
                event.preventDefault();
                return false;
            }
        });

        console.log("✅ Enhanced static mode fixes with Next.js support applied");
    });

    // Handle unhandled promise rejections from missing chunks and network failures
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason ? event.reason.toString() : '';
        if (reason.includes('ChunkLoadError') ||
            reason.includes('Loading chunk') ||
            reason.includes('ERR_FILE_NOT_FOUND') ||
            reason.includes('net::ERR_FILE_NOT_FOUND') ||
            reason.includes('/_next/image') ||
            reason.includes('Cannot read properties of undefined')) {
            console.warn('🔧 Suppressing chunk/network load error:', reason);
            event.preventDefault();
        }
    });
}
</script>
  `);

  // Final cleanup - remove any remaining Next.js API references and replace with actual images
  $('img[src*="/_next/image"], img[srcset*="/_next/image"], img[src*="/api/"], script[src*="gtag/js"], script[src*="/api/"], link[imagesrcset*="/_next/image"], link[href*="/_next/image"]').each((i, element) => {
    const el = $(element);
    if (el.is('img')) {
      const src = el.attr('src');
      const srcset = el.attr('srcset');
      
      // Handle srcset attribute
      if (srcset && srcset.includes('/_next/image')) {
        console.log('🧹 Final cleanup: Removing Next.js srcset attribute');
        el.removeAttr('srcset');
      }
      
      if (src && src.includes('/_next/image')) {
        // Try to extract the original image path from Next.js URL
        try {
          const url = new URL(src, baseUrl);
          const urlParam = url.searchParams.get('url');
          if (urlParam) {
            const originalPath = decodeURIComponent(urlParam);
            const cleanPath = originalPath.startsWith('/') ? originalPath.substring(1) : originalPath;
            
            // Try to find the corresponding downloaded image
            // Check if we have this resource in our collection
            let resourceFound = false;
            
            // First try exact match
            if (resources.has(cleanPath)) {
              el.attr('src', cleanPath);
              console.log(`🔧 Final cleanup: Replacing Next.js image ${src} with local image: ${cleanPath}`);
              resourceFound = true;
            } else {
              // Try fuzzy matching
              for (const resourcePath of resources.keys()) {
                if (resourcePath.endsWith(cleanPath) || 
                    posixPath.basename(resourcePath) === posixPath.basename(cleanPath)) {
                  el.attr('src', resourcePath);
                  console.log(`🔧 Final cleanup: Replacing Next.js image ${src} with local image: ${resourcePath}`);
                  resourceFound = true;
                  break;
                }
              }
            }
            
            if (resourceFound) {
              return;
            }
          }
        } catch (e) {
          // Failed to parse URL, fall back to placeholder
        }
        
        console.log('🧹 Final cleanup: Replacing remaining Next.js image with placeholder');
        el.attr('src', 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2RkZCIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlPC90ZXh0Pjwvc3ZnPg==');
        el.css('opacity', '0.5');
      }
    } else if (el.is('link')) {
      // Handle link tags with Next.js image references
      const imagesrcset = el.attr('imagesrcset');
      const href = el.attr('href');
      
      if (imagesrcset && imagesrcset.includes('/_next/image')) {
        console.log('🧹 Final cleanup: Removing Next.js image preload link');
        el.remove();
      } else if (href && href.includes('/_next/image')) {
        console.log('🧹 Final cleanup: Removing Next.js image href link');
        el.remove();
      }
    } else if (el.is('script')) {
      console.log('🧹 Final cleanup: Removing API script');
      el.remove();
    }
  });

  const finalHtml = $.html();
  zip.file('index.html', finalHtml);

  // First pass: collect all external images from CSS files
  console.log('🔍 First pass: scanning CSS files for external images...');
  for (const [filePath, { buffer, contentType }] of resources.entries()) {
    if (contentType.includes('css') && !filePath.includes('data:')) {
      try {
        const cssContent = buffer.toString('utf-8');
        cssContent.replace(/url\(([^)]+)\)/g, (match, urlContent) => {
          const originalUrl = urlContent.trim().replace(/['"]/g, '');
          
          if (originalUrl && /^https?:\/\//.test(originalUrl)) {
            try {
              const urlObj = new URL(originalUrl);
              const fileName = posixPath.basename(urlObj.pathname) || 'image';
              const extension = fileName.includes('.') ? '' : '.jpg';
              const localFileName = `external_images/${fileName}${extension}`;
              
              console.log(`📥 Found external image in CSS: ${originalUrl}`);
              externalImagesToDownload.add({
                url: originalUrl,
                localPath: localFileName
              });
            } catch (e) {
              // Invalid URL, skip
            }
          }
          return match;
        });
      } catch (e) {
        // Error reading CSS, skip
      }
    }
  }

  // Download external images that were found in CSS
  console.log(`📥 Processing ${externalImagesToDownload.size} external images...`);
  for (const { url: imageUrl, localPath } of externalImagesToDownload) {
    try {
      console.log(`📥 Downloading external image: ${imageUrl}`);
      const response = await fetch(imageUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        
        resources.set(localPath, { buffer, contentType });
        console.log(`✅ Downloaded external image: ${localPath}`);
      } else {
        console.warn(`❌ Failed to download external image (${response.status}): ${imageUrl}`);
      }
    } catch (e) {
      console.warn(`❌ Failed to download external image: ${imageUrl} - ${e}`);
    }
  }

  // Add all resources to ZIP
  for (const [filePath, { buffer, contentType }] of resources.entries()) {
    if (filePath === 'index.html') continue;

    if (contentType.includes('css') && !filePath.includes('data:')) {
      try {
        const cssContent = buffer.toString('utf-8');
        const cssDir = posixPath.dirname(filePath);

        const findMatchingKey = (p: string) => {
          if (!p) return undefined;
          if (resources.has(p)) return p;
          const cleanPath = (p.split('?')[0] || p).split('#')[0] || p;
          if (resources.has(cleanPath)) return cleanPath;
          for (const key of resources.keys()) {
            if (key.startsWith(cleanPath + '?')) {
              return key;
            }
          }
          return undefined;
        };

        const updatedCssContent = cssContent.replace(/url\(([^)]+)\)/g, (match, urlContent) => {
          const originalUrl = urlContent.trim().replace(/['"]/g, '');

          if (!originalUrl || originalUrl.startsWith('data:') || originalUrl.startsWith('#')) {
            return match;
          }

          // Handle external URLs (use already downloaded images)
          if (/^https?:\/\//.test(originalUrl)) {
            try {
              const urlObj = new URL(originalUrl);
              const fileName = posixPath.basename(urlObj.pathname) || 'image';
              const extension = fileName.includes('.') ? '' : '.jpg'; // Default extension if none
              const localFileName = `external_images/${fileName}${extension}`;
              
              // Check if we have this external image (should be downloaded by now)
              const existingKey = findMatchingKey(localFileName);
              if (existingKey) {
                const newRelativePath = posixPath.relative(cssDir, existingKey);
                const finalPath = newRelativePath.replace(/\\/g, '/');
                console.log(`🔗 Replaced external URL ${originalUrl} with local path: ${finalPath}`);
                return `url('${finalPath}')`;
              } else {
                console.warn(`External image not found in resources: ${localFileName} for URL: ${originalUrl}`);
              }
            } catch (e) {
              console.warn(`Failed to parse external URL: ${originalUrl}`);
            }
          }

          let resourceKey: string | undefined;
          const cleanOriginalUrl = originalUrl.split('?')[0].split('#')[0];

          if (/^(https?:)?\/\//.test(originalUrl)) {
            try {
              const urlObj = new URL(originalUrl);
              const p = (urlObj.pathname.substring(1) + urlObj.search).replace(/\/$/, '');
              resourceKey = findMatchingKey(p);
            } catch (e) { /* invalid url */ }
          } else if (originalUrl.startsWith('/')) {
            resourceKey = findMatchingKey(cleanOriginalUrl.substring(1));
          } else {
            const p1 = posixPath.normalize(posixPath.join(cssDir, cleanOriginalUrl));
            resourceKey = findMatchingKey(p1);
            if (!resourceKey) {
              const p2 = posixPath.normalize(cleanOriginalUrl);
              resourceKey = findMatchingKey(p2);
            }
          }

          if (resourceKey) {
            const newRelativePath = posixPath.relative(cssDir, resourceKey!);
            const finalPath = newRelativePath.replace(/\\/g, '/');
            return `url('${finalPath}')`;
          }

          console.warn(`Could not find resource for CSS url "${originalUrl}" in ${filePath}`);
          return match;
        });

        zip.file(filePath, updatedCssContent);
      } catch (e) {
        console.error(`Could not process CSS file ${filePath}: ${e}`);
        zip.file(filePath, buffer);
      }
    } else {
      zip.file(filePath, buffer);
    }
  }

  progressCallback(0.9);

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 9
    }
  });

  await fs.writeFile('standalone-site.zip', content);
  progressCallback(1);

  console.log('Clone completed successfully, ZIP file saved as standalone-site.zip');
  return content;
}