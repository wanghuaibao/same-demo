import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import puppeteer from 'puppeteer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as posixPath from 'path/posix';

export async function clone(url: string, progressCallback: (p: number, message?: string) => void): Promise<Buffer> {
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
    
    // Block Next.js API routes and dynamic features that won't work in static mode
    if (requestUrl.includes('/_next/image') || 
        requestUrl.includes('/api/') ||
        requestUrl.includes('/_next/webpack-hmr') ||
        requestUrl.includes('/_next/static/chunks/pages/api/') ||
        resourceType === 'websocket') {
      console.log(`Blocking Next.js API/dynamic resource: ${requestUrl}`);
      request.abort();
      return;
    }
    
    // Allow all Next.js static resources
    if (requestUrl.includes('/_next/static/')) {
      console.log(`Allowing Next.js static resource: ${requestUrl}`);
      request.continue();
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

          // Update progress with detailed message
          const progress = Math.min(resources.size / 50, 0.8); // Rough estimation

          // Handle potential file/directory conflicts
          // If we already have a file with this name, and now we need a directory with the same name
          if (resources.has(pathName)) {
            // Check if this is a directory conflict (new path has nested structure)
            const isNestedPath = pathName.includes('/');
            if (isNestedPath) {
              const basePath = pathName.split('/')[0];
              if (basePath && resources.has(basePath)) {
                // Rename the existing file to avoid conflict
                const existingResource = resources.get(basePath);
                if (existingResource) {
                  resources.delete(basePath);
                  resources.set(`${basePath}_file`, existingResource);
                  console.log(`🔄 Renamed conflicting file: ${basePath} -> ${basePath}_file`);
                  progressCallback(progress, `🔄 Renamed conflicting file: ${basePath} -> ${basePath}_file`);
                }
              }
            } else {
              return; // Skip duplicate file
            }
          }

          resources.set(pathName, { buffer, contentType });
          console.log(`Downloaded: ${pathName}`);
          progressCallback(progress, `Downloaded: ${pathName}`);
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
    progressCallback(0.8, 'Waiting for dynamic content to load...');
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
          progressCallback(0.8, `📸 Found original image to download: ${originalPath}`);
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
        progressCallback(0.85, `✅ Downloaded original image: ${imagePath}`);
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
                progressCallback(0.87, `🖼️ Replacing Next.js image with original: ${cleanPath}`);
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
        progressCallback(0.87, `🗑️ Removing API resource: ${resourceUrl}`);
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
              progressCallback(0.87, `⚠️ Could not find resource: ${localPath} (original: ${resourceUrl})`);
            }
          }
        } catch (e) {
          console.log(`Skipping invalid URL in attribute ${attr}: ${resourceUrl}`);
        }
      }
    }
  });

  // Add Raphael.app specific optimizations
  $('head').append(`
    <script>
console.log("🎨 Raphael.app specific optimizations loaded");
    </script>
  `);

  // Add ULTIMATE preview path fix - must run FIRST
  $('head').append(`
    <script>
// ULTIMATE Next.js Preview Fix - Intercept ALL module loading
(function() {
    const isPreviewMode = window.location.href.includes('/preview/');
    if (!isPreviewMode) return;
    
    const matches = window.location.pathname.match(/\\/preview\\/([^\\/]+)/);
    if (!matches) return;
    
    const previewBasePath = '/preview/' + matches[1];
    console.log('🎯 Ultimate Next.js fix activating for:', previewBasePath);
    
    // Store globally for access
    window._previewBasePath = previewBasePath;
    
    // Intercept webpack's public path setting - HIGHEST PRIORITY
    let webpackPublicPathSet = false;
    Object.defineProperty(window, '__webpack_public_path__', {
        get() { return this._wpPublicPath || previewBasePath + '/_next/'; },
        set(value) { 
            this._wpPublicPath = previewBasePath + '/_next/';
            console.log('🔄 Intercepted __webpack_public_path__ setting:', this._wpPublicPath);
        }
    });
    
    // Intercept webpack require definition
    let originalWebpackRequire = null;
    Object.defineProperty(window, '__webpack_require__', {
        get() { return this._webpackRequire; },
        set(value) {
            this._webpackRequire = value;
            if (value && !webpackPublicPathSet) {
                value.p = previewBasePath + '/_next/';
                webpackPublicPathSet = true;
                console.log('🔄 Set webpack.p to:', value.p);
            }
            
            // Intercept chunk loading function
            if (value && value.l && !value._previewPatched) {
                const originalL = value.l;
                value.l = function(url, done, key, chunkId) {
                    if (typeof url === 'string' && url.startsWith('/_next/')) {
                        url = previewBasePath + url;
                        console.log('🔄 Redirecting chunk load:', url);
                    }
                    return originalL.call(this, url, done, key, chunkId);
                };
                value._previewPatched = true;
            }
            
            // Intercept dynamic import
            if (value && value.e && !value._importPatched) {
                const originalE = value.e;
                value.e = function(chunkId) {
                    // Try to intercept and fix the URL at the source
                    const result = originalE.call(this, chunkId);
                    if (result && result.catch) {
                        return result.catch(error => {
                            console.warn('🔧 Chunk load failed, intercepting:', error);
                            return Promise.reject(error);
                        });
                    }
                    return result;
                };
                value._importPatched = true;
            }
        }
    });
    
    // Patch document.createElement for script elements
    const originalCreateElement = document.createElement;
    document.createElement = function(tagName) {
        const element = originalCreateElement.call(this, tagName);
        
        if (tagName.toLowerCase() === 'script') {
            let srcSet = false;
            Object.defineProperty(element, 'src', {
                get() { return this._src || ''; },
                set(value) {
                    if (typeof value === 'string' && value.startsWith('/_next/')) {
                        this._src = previewBasePath + value;
                        console.log('🔄 Script src rewritten:', value, '->', this._src);
                    } else {
                        this._src = value;
                    }
                    if (!srcSet) {
                        srcSet = true;
                        originalCreateElement.call(document, 'script').src = this._src;
                    }
                }
            });
        }
        
        return element;
    };
    
    // Patch link elements for CSS
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if (this.tagName === 'LINK' && name === 'href' && typeof value === 'string' && value.startsWith('/_next/')) {
            value = previewBasePath + value;
            console.log('🔄 Link href rewritten:', value);
        }
        return originalSetAttribute.call(this, name, value);
    };
    
    console.log('✅ Ultimate Next.js preview fix installed');
})();
    </script>
  `);

  // Add simplified but effective Next.js fix script
  $('head').append(`
    <script>
console.log("🚀 Enhanced static clone script with Next.js support loaded");

// Enhanced fetch wrapper with preview path support
(function() {
    const isPreviewMode = window.location.href.includes('/preview/');
    const previewBasePath = window._previewBasePath || '';
    
    if (window.location.protocol === 'file:' || isPreviewMode) {
        console.log("📁 Static mode detected, applying network fixes...");
        
        const originalFetch = window.fetch;
        const originalXhrOpen = window.XMLHttpRequest.prototype.open;
        
        // Enhanced fetch wrapper with better URL handling
        window.fetch = function(input, init) {
            let url = typeof input === 'string' ? input : input.url;
            
            if (typeof url === 'string' && url.startsWith('/_next/')) {
                const newUrl = previewBasePath + url;
                console.log('🔄 Fetch rewritten:', url, '->', newUrl);
                
                if (typeof input === 'string') {
                    input = newUrl;
                } else if (input.url) {
                    input = new Request(newUrl, input);
                }
            }
            
            // Block API calls
            if (url.includes('/api/')) {
                console.log('🚫 API call blocked:', url);
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            
            return originalFetch.call(this, input, init).catch(error => {
                console.warn('🔧 Fetch failed, returning empty response:', error);
                return new Response('{}', { status: 200 });
            });
        };

        // Enhanced XHR wrapper
        window.XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            let modifiedUrl = url;
            
            if (isPreviewMode && typeof url === 'string' && url.startsWith('/_next/')) {
                modifiedUrl = previewBasePath + url;
                console.log('🔄 Redirecting XHR request:', url, '->', modifiedUrl);
            }
            
            if (modifiedUrl.includes('/api/') || modifiedUrl.includes('/_next/image')) {
                console.log('🚫 XHR request blocked:', modifiedUrl);
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
            return originalXhrOpen.call(this, method, modifiedUrl, async, user, password);
        };
        
        // Error suppression
        window.addEventListener('error', (event) => {
            const errorMessage = event.message || '';
            if (errorMessage.includes('ChunkLoadError') || 
                errorMessage.includes('Loading chunk') ||
                errorMessage.includes('ERR_FILE_NOT_FOUND') ||
                errorMessage.includes('/_next/')) {
                console.warn('🔧 Suppressing Next.js error:', errorMessage);
                event.preventDefault();
                return false;
            }
        });
        
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason ? event.reason.toString() : '';
            if (reason.includes('ChunkLoadError') ||
                reason.includes('Loading chunk') ||
                reason.includes('ERR_FILE_NOT_FOUND') ||
                reason.includes('/_next/')) {
                console.warn('🔧 Suppressing chunk load error:', reason);
                event.preventDefault();
            }
        });
    }
})();
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
  progressCallback(0.90, '🧹 Final cleanup: Removing Next.js srcset attribute');
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
  progressCallback(0.90, '🔍 First pass: scanning CSS files for external images...');
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
  progressCallback(0.93, `📥 Processing ${externalImagesToDownload.size} external images...`);
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

  progressCallback(0.95, 'Creating ZIP file...');

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 9
    }
  });

  await fs.writeFile('standalone-site.zip', content);
  progressCallback(1, 'Clone completed successfully!');

  console.log('Clone completed successfully, ZIP file saved as standalone-site.zip');
  progressCallback(1.0, 'Clone completed successfully!');
  return content;
}