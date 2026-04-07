#!/usr/bin/env node

/**
 * Hong Kong Merchant Shipping Information Notes Scraper (JavaScript/Node.js)
 * Extracts structured data from MSIN notices and their PDFs
 * Includes OCR support for scanned/image-based PDFs
 * Includes table extraction from PDFs
 */

const puppeteer = require('puppeteer');
const axios = require('axios');
const pdf = require('pdf-parse');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const { PDFDocument } = require('pdf-lib');
const { pdfToPng } = require('pdf-to-png-converter');

// Note: pdf-table-extractor is not compatible with modern Node.js (canvas issues)
// We rely on text-based table detection instead

class MSINScraper {
    constructor(baseUrl, options = {}) {
        this.baseUrl = baseUrl;
        this.failedPdfs = [];
        this.browser = null;
        this.page = null;
        this.pdfDir = path.join(process.cwd(), 'pdfs');
        this.stateFile = path.join(process.cwd(), '.scraper_state.json');
        
        // Configuration options with defaults
        this.options = {
            concurrency: options.concurrency || 1,        // Sequential by default (safest)
            rateLimit: options.rateLimit || 1000,         // 1 second between requests
            incremental: options.incremental !== false,   // Skip already downloaded
            verbose: options.verbose || false,            // Detailed logging
            quiet: options.quiet || false,                // Minimal logging
            ...options
        };
        
        // Rate limiting state - now concurrency-safe
        this.lastRequestTime = 0;
        this.rateLimitLock = Promise.resolve();
        
        // State save throttling
        this.stateSaveTimeout = null;
        this.pendingState = null;
    }
    
    log(message, level = 'info') {
        if (this.options.quiet && level !== 'error') return;
        if (level === 'debug' && !this.options.verbose) return;
        console.log(message);
    }
    
    async ensurePdfDirectory() {
        try {
            await fs.access(this.pdfDir);
        } catch {
            await fs.mkdir(this.pdfDir, { recursive: true });
            this.log(`Created PDF directory: ${this.pdfDir}`);
        }
    }
    
    // Progress persistence methods
    async loadState() {
        try {
            const data = await fs.readFile(this.stateFile, 'utf8');
            return JSON.parse(data);
        } catch {
            return { processedNotices: {}, lastRun: null };
        }
    }
    
    // Throttled state save - prevents write contention (stores minimal data)
    async saveStateThrottled(state) {
        // Create lightweight state without full_text to reduce file size
        const lightweightState = {
            processedNotices: {},
            lastRun: state.lastRun
        };
        
        // Store only essential metadata, not full content
        for (const [noticeNumber, noticeData] of Object.entries(state.processedNotices)) {
            lightweightState.processedNotices[noticeNumber] = {
                status: noticeData.status,
                processedAt: noticeData.processedAt,
                error: noticeData.error,
                // Store only minimal data for verification
                metadata: noticeData.data ? {
                    notice_number: noticeData.data.notice_number,
                    title: noticeData.data.title,
                    issue_date: noticeData.data.issue_date,
                    pdf_url: noticeData.data.pdf_url,
                    local_path: noticeData.data.local_path
                } : null
            };
        }
        
        this.pendingState = lightweightState;
        
        if (this.stateSaveTimeout) {
            return; // Already scheduled
        }
        
        this.stateSaveTimeout = setTimeout(async () => {
            this.stateSaveTimeout = null;
            if (this.pendingState) {
                await fs.writeFile(this.stateFile, JSON.stringify(this.pendingState, null, 2), 'utf8');
            }
        }, 1000); // Save at most once per second
    }
    
    // Immediate state save (for final save) - stores minimal data
    async saveState(state) {
        if (this.stateSaveTimeout) {
            clearTimeout(this.stateSaveTimeout);
            this.stateSaveTimeout = null;
        }
        
        // Create lightweight state without full_text to reduce file size
        const lightweightState = {
            processedNotices: {},
            lastRun: state.lastRun
        };
        
        // Store only essential metadata, not full content
        for (const [noticeNumber, noticeData] of Object.entries(state.processedNotices)) {
            lightweightState.processedNotices[noticeNumber] = {
                status: noticeData.status,
                processedAt: noticeData.processedAt,
                error: noticeData.error,
                // Store only minimal data for verification
                metadata: noticeData.data ? {
                    notice_number: noticeData.data.notice_number,
                    title: noticeData.data.title,
                    issue_date: noticeData.data.issue_date,
                    pdf_url: noticeData.data.pdf_url,
                    local_path: noticeData.data.local_path
                } : null
            };
        }
        
        await fs.writeFile(this.stateFile, JSON.stringify(lightweightState, null, 2), 'utf8');
    }
    
    async clearState() {
        try {
            await fs.unlink(this.stateFile);
        } catch {
            // File doesn't exist, that's fine
        }
    }
    
    // Check if a notice was already processed
    isNoticeProcessed(state, noticeNumber) {
        return state.processedNotices[noticeNumber] && 
               state.processedNotices[noticeNumber].status === 'done';
    }
    
    // Detect language from text content
    detectLanguage(text) {
        if (!text || text.trim().length === 0) return 'unknown';
        
        // Count Chinese characters
        const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const totalChars = text.replace(/\s/g, '').length;
        
        // If more than 30% Chinese characters, consider it Chinese
        if (totalChars > 0 && (chineseChars / totalChars) > 0.3) {
            return 'chinese';
        }
        
        return 'english';
    }
    
    // Proper rate limiting - ensures minimum gap between ANY requests (concurrency-safe)
    async waitForRateLimit() {
        // Chain requests to ensure they're serialized
        this.rateLimitLock = this.rateLimitLock.then(async () => {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            const waitTime = Math.max(0, this.options.rateLimit - timeSinceLastRequest);
            
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            
            this.lastRequestTime = Date.now();
        });
        
        await this.rateLimitLock;
    }
    
    // Process items with proper concurrency control
    async processWithConcurrency(items, processFn) {
        const results = new Array(items.length);
        let currentIndex = 0;
        let completedCount = 0;
        
        const worker = async (workerId) => {
            while (currentIndex < items.length) {
                const index = currentIndex++;
                const item = items[index];
                
                try {
                    results[index] = await processFn(item, index);
                } catch (error) {
                    this.log(`  Worker ${workerId} error on item ${index}: ${error.message}`, 'error');
                    results[index] = null;
                }
                
                completedCount++;
            }
        };
        
        // Start workers up to concurrency limit
        const workers = [];
        const workerCount = Math.min(this.options.concurrency, items.length);
        
        for (let i = 0; i < workerCount; i++) {
            workers.push(worker(i + 1));
        }
        
        await Promise.all(workers);
        
        return results;
    }
    
    generatePdfFilename(noticeNumber, lang = 'en') {
        // Convert "MSIN No. 04/2024" to "msin_04_2024_en.pdf"
        const match = noticeNumber.match(/(\d+)\/(\d{4})/);
        if (match) {
            const num = match[1].padStart(2, '0');
            const year = match[2];
            return `msin_${num}_${year}_${lang}.pdf`;
        }
        // Fallback: sanitize the notice number
        const sanitized = noticeNumber.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        return `${sanitized}_${lang}.pdf`;
    }
    
    async savePdfLocally(pdfBuffer, filename) {
        const localPath = path.join(this.pdfDir, filename);
        await fs.writeFile(localPath, pdfBuffer);
        return localPath;
    }
    
    getChinesePdfUrl(englishPdfUrl) {
        // Pattern: msin2024004e.pdf -> msin2024004c.pdf
        // Or: /en/ -> /tc/ in path
        let chineseUrl = englishPdfUrl;
        
        // Try replacing 'e.pdf' with 'c.pdf' at the end
        if (/e\.pdf$/i.test(englishPdfUrl)) {
            chineseUrl = englishPdfUrl.replace(/e\.pdf$/i, 'c.pdf');
        }
        // Also try replacing /en/ with /tc/ in path
        else if (englishPdfUrl.includes('/en/')) {
            chineseUrl = englishPdfUrl.replace('/en/', '/tc/');
        }
        
        return chineseUrl !== englishPdfUrl ? chineseUrl : null;
    }

    async initBrowser() {
        this.log('Initializing browser...', 'debug');
        try {
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920,1080'
                ],
                timeout: 60000
            });
            this.page = await this.browser.newPage();
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await this.page.setViewport({ width: 1920, height: 1080 });
            
            // Set longer timeout for navigation
            await this.page.setDefaultNavigationTimeout(60000);
            await this.page.setDefaultTimeout(60000);
        } catch (error) {
            this.log(`Failed to initialize browser: ${error.message}`, 'error');
            throw error;
        }
    }

    async closeBrowser() {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (error) {
                this.log(`Error closing browser: ${error.message}`, 'debug');
            }
        }
    }

    async scrapeIndexPage() {
        this.log(`Fetching index page: ${this.baseUrl}`);
        
        try {
            await this.initBrowser();
            await this.page.goto(this.baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            this.log('Waiting for page to load...');
            await new Promise(resolve => setTimeout(resolve, 4000));
            
            const notices = [];
            let pageNum = 1;
            const maxPages = 50; // Safety limit for pagination
            
            while (pageNum <= maxPages) {
                this.log(`Scraping page ${pageNum}...`);
                
                // Get page content
                const pageNotices = await this.page.evaluate(() => {
                    const results = [];
                    const rows = document.querySelectorAll('tr');
                    
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 3) {
                            // Skip header rows
                            if (row.querySelector('th')) return;
                            
                            // Extract date from first cell
                            const dateCell = cells[0].textContent.trim();
                            let issueDate = 'Not specified';
                            
                            if (dateCell && /\d/.test(dateCell)) {
                                try {
                                    const parsed = new Date(dateCell);
                                    if (!isNaN(parsed.getTime())) {
                                        // Use local date components to avoid timezone issues
                                        const year = parsed.getFullYear();
                                        const month = String(parsed.getMonth() + 1).padStart(2, '0');
                                        const day = String(parsed.getDate()).padStart(2, '0');
                                        issueDate = `${year}-${month}-${day}`;
                                    }
                                } catch (e) {
                                    // Keep as "Not specified"
                                }
                            }
                            
                            // Extract notice number from second cell
                            const noticeNumberCell = cells[1].textContent.trim();
                            const noticeNumber = noticeNumberCell ? `MSIN No. ${noticeNumberCell}` : 'Not specified';
                            
                            // Extract title, PDF URL, and attachments from third cell
                            const titleCell = cells[2];
                            const mainLink = titleCell.querySelector('a[href*=".pdf"]');
                            
                            if (mainLink) {
                                // Get title (remove trailing " PDF" if present)
                                let title = mainLink.textContent.trim();
                                title = title.replace(/\s+PDF$/i, '');
                                
                                const pdfHref = mainLink.getAttribute('href');
                                
                                if (pdfHref) {
                                    const pdfUrl = new URL(pdfHref, window.location.href).href;
                                    
                                    // Extract attachments (all PDF links after the main one)
                                    const attachments = [];
                                    const allLinks = titleCell.querySelectorAll('a[href*=".pdf"]');
                                    
                                    // Skip first link (main document), collect rest as attachments
                                    for (let i = 1; i < allLinks.length; i++) {
                                        const attachLink = allLinks[i];
                                        const attachName = attachLink.textContent.trim();
                                        const attachHref = attachLink.getAttribute('href');
                                        
                                        if (attachName && attachHref) {
                                            attachments.push({
                                                name: attachName,
                                                pdf_url: new URL(attachHref, window.location.href).href
                                            });
                                        }
                                    }
                                    
                                    results.push({
                                        noticeNumber,
                                        title,
                                        issueDate,
                                        pdfUrl,
                                        attachmentsFromWeb: attachments
                                    });
                                }
                            }
                        }
                    });
                    
                    return results;
                });
                
                this.log(`  Found ${pageNotices.length} notices on page ${pageNum}`);
                notices.push(...pageNotices);
                
                // If no notices found, we've reached the end
                if (pageNotices.length === 0) {
                    break;
                }
                
                // Try to go to next page using JavaScript
                try {
                    const nextPage = pageNum + 1;
                    await this.page.evaluate((page) => {
                        whatsNewObj.goToPage(page);
                    }, nextPage);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    pageNum = nextPage;
                } catch (e) {
                    this.log(`  Could not navigate to page ${pageNum + 1}: ${e.message}`, 'debug');
                    break;
                }
            }
            
            this.log(`Found ${notices.length} total notices across ${pageNum} pages`);
            
            // Deduplicate by notice number (some notices might appear on multiple pages)
            const uniqueNotices = [];
            const seenNumbers = new Set();
            for (const notice of notices) {
                if (!seenNumbers.has(notice.noticeNumber)) {
                    seenNumbers.add(notice.noticeNumber);
                    uniqueNotices.push(notice);
                }
            }
            
            if (uniqueNotices.length < notices.length) {
                this.log(`Deduplicated to ${uniqueNotices.length} unique notices`);
            }
            
            return uniqueNotices;
            
        } finally {
            await this.closeBrowser();
        }
    }

    async downloadWithRetry(url, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Wait for rate limit before each request (including retries)
                await this.waitForRateLimit();
                
                const response = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    maxContentLength: 50 * 1024 * 1024,
                    validateStatus: (status) => status === 200
                });
                
                if (!response.data || response.data.byteLength === 0) {
                    throw new Error('Empty PDF response');
                }
                
                return response;
            } catch (error) {
                lastError = error;
                
                // Don't retry on permanent errors (4xx status codes)
                const status = error.response?.status;
                if (status && status >= 400 && status < 500) {
                    this.log(`  Permanent error (HTTP ${status}), not retrying`, 'debug');
                    throw error;
                }
                
                if (attempt < maxRetries) {
                    // Exponential backoff: 2s, 4s, 8s (longer delays to let server recover)
                    const delay = Math.pow(2, attempt) * 1000;
                    this.log(`  Retry ${attempt}/${maxRetries} failed (${error.message}), waiting ${delay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        throw lastError;
    }

    async renderPdfPage(pageData) {
        const renderOptions = {
            normalizeWhitespace: false,
            disableCombineTextItems: false
        };

        const textContent = await pageData.getTextContent(renderOptions);
        let lastY;
        let text = '';

        for (const item of textContent.items) {
            if (lastY === item.transform[5] || lastY == null) {
                text += item.str;
            } else {
                text += '\n' + item.str;
            }

            lastY = item.transform[5];
        }

        return text;
    }

    async extractTextByPage(pdfBuffer) {
        const rawPageTexts = [];
        const data = await pdf(pdfBuffer, {
            pagerender: async (pageData) => {
                try {
                    const rawText = await this.renderPdfPage(pageData);
                    rawPageTexts.push(rawText);
                    return rawText;
                } catch (error) {
                    this.log(`  Page text extraction failed: ${error.message}`, 'debug');
                    rawPageTexts.push('');
                    return '';
                }
            }
        });

        const pageCount = data.numpages || rawPageTexts.length;
        while (rawPageTexts.length < pageCount) {
            rawPageTexts.push('');
        }

        const pages = rawPageTexts.map((rawText, index) => ({
            page: index + 1,
            text: this.cleanText(rawText)
        }));

        return {
            data,
            pageCount,
            pages,
            fullText: this.cleanText(data.text || rawPageTexts.join('\n\n'))
        };
    }

    async downloadAndParsePdf(pdfUrl, options = {}) {
        let worker = null;
        const { silent = false } = options; // Don't log errors or track failures when silent
        
        try {
            this.log(`Downloading PDF: ${pdfUrl}`, 'debug');
            
            const response = await this.downloadWithRetry(pdfUrl);
            const pdfBuffer = Buffer.from(response.data);
            const extractedText = await this.extractTextByPage(pdfBuffer);
            
            const pageCount = extractedText.pageCount || 0;
            let fullText = extractedText.fullText;
            const originalText = fullText; // Keep original text as backup
            const originalPages = extractedText.pages;
            let pages = originalPages;
            
            // Detect language from extracted text
            const detectedLang = this.detectLanguage(fullText);
            
            // Check if text extraction is poor (likely scanned PDF)
            // Use language-specific thresholds (Chinese is more information-dense)
            const threshold = detectedLang === 'chinese' ? 50 : 100;
            const textIsSparse = !fullText || fullText.trim().length < threshold;
            
            if (textIsSparse) {
                this.log('  PDF appears to be scanned or has sparse text - performing OCR...');
                this.log(`  Original text length: ${originalText ? originalText.length : 0} chars`, 'debug');
                this.log(`  Detected language: ${detectedLang}`, 'debug');
                
                // Initialize Tesseract worker with language-specific models
                const ocrLangs = detectedLang === 'chinese' ? 'chi_tra+chi_sim' : 'eng+chi_tra+chi_sim';
                worker = await createWorker(ocrLangs, 1, {
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            this.log(`    Tesseract progress: ${Math.round(m.progress * 100)}%`);
                        }
                    }
                });
                
                // Perform OCR on entire PDF - returns both fullText and pages
                const ocrResult = await this.ocrEntirePdf(pdfBuffer, worker, pageCount);
                
                if (ocrResult.fullText && ocrResult.fullText.trim().length > 50) {
                    fullText = ocrResult.fullText;
                    pages = ocrResult.pages;
                    this.log(`  OCR successful: extracted ${fullText.length} characters`);
                } else {
                    this.log(`  OCR returned minimal text (${ocrResult.fullText ? ocrResult.fullText.length : 0} chars)`, 'debug');
                    // Keep original text if OCR failed
                    if (!ocrResult.fullText || ocrResult.fullText.trim().length === 0) {
                        if (originalText && originalText.trim().length > 0) {
                            this.log(`  Keeping original text (${originalText.length} chars)`, 'debug');
                            fullText = originalText;
                            pages = originalPages;
                        } else {
                            this.log(`  WARNING: Both OCR and text extraction failed`);
                            fullText = ocrResult.fullText || originalText || '';
                            pages = ocrResult.pages.length > 0 ? ocrResult.pages : originalPages;
                        }
                    } else {
                        fullText = ocrResult.fullText;
                        pages = ocrResult.pages;
                    }
                }
            } else {
                // Check for embedded images that might need OCR
                const hasImages = await this.pdfHasImages(pdfBuffer);
                
                if (hasImages) {
                    this.log('  PDF contains images - performing OCR on images...');
                    const ocrLangs = detectedLang === 'chinese' ? 'chi_tra+chi_sim' : 'eng+chi_tra+chi_sim';
                    worker = await createWorker(ocrLangs, 1, {
                        logger: m => {
                            if (m.status === 'recognizing text') {
                                this.log(`    Tesseract progress: ${Math.round(m.progress * 100)}%`);
                            }
                        }
                    });
                    const ocrResult = await this.ocrPdfPages(pdfBuffer, worker, pageCount);
                    
                    if (ocrResult.fullText && ocrResult.fullText.trim().length > 50) {
                        fullText += '\n\n[OCR from embedded images]\n' + ocrResult.fullText;
                        this.log(`  OCR from images: extracted ${ocrResult.fullText.length} characters`);
                    }
                }
            }
            
            if (!fullText || fullText.trim().length === 0) {
                this.log('  WARNING: No text extracted - PDF may be corrupted or unreadable');
                // Don't throw error, just flag it
                fullText = '[No text could be extracted from this PDF - manual review required]';
                pages = [{
                    page: 1,
                    text: fullText
                }];
            }
            
            if (fullText.trim().length < 50 && fullText.trim().length > 0) {
                this.log(`  WARNING: Very little text extracted (${fullText.trim().length} chars)`);
            }
            
            // Ensure we have pages data
            if (!pages || pages.length === 0) {
                pages = originalPages.length > 0 ? originalPages : this.splitIntoPages(fullText, pageCount);
            }
            
            // Extract metadata from PDF content (language-aware)
            const subject = this.extractSubject(fullText, detectedLang);
            const issuedBy = this.extractIssuedBy(fullText, detectedLang);
            const effectiveDate = this.extractEffectiveDate(fullText, detectedLang);
            const summary = this.extractSummary(fullText, detectedLang);
            
            // Extract tables from PDF text
            let tables = [];
            try {
                tables = await this.extractTablesFromPdf(pdfBuffer, fullText);
                
                if (tables.length > 0) {
                    this.log(`  ✓ Extracted ${tables.length} table(s)`, 'debug');
                }
            } catch (tableError) {
                this.log(`  Table extraction failed: ${tableError.message}`, 'debug');
            }
            
            return {
                pageCount,
                pages,
                fullText,
                subject,
                issuedBy,
                effectiveDate,
                summary,
                tables,
                pdfBuffer // Include buffer for local saving
            };
            
        } catch (error) {
            if (!silent) {
                this.log(`ERROR: Failed to process PDF ${pdfUrl}: ${error.message}`, 'error');
                this.failedPdfs.push({ url: pdfUrl, error: error.message });
            }
            return null;
        } finally {
            // Clean up Tesseract worker
            if (worker) {
                await worker.terminate();
            }
        }
    }
    
    async pdfHasImages(pdfBuffer) {
        try {
            const pdfDoc = await PDFDocument.load(pdfBuffer);
            const pages = pdfDoc.getPages();
            
            // Check if any page has images
            for (const page of pages) {
                const { Resources } = page.node;
                if (Resources && Resources.lookup && Resources.lookup('XObject')) {
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            this.log('  Could not check for images: ' + error.message, 'debug');
            return false;
        }
    }
    
    async convertPdfPageToImage(pdfBuffer, pageNumber) {
        let tempPdfPath = null;
        
        try {
            // Save PDF temporarily in current directory
            const timestamp = Date.now();
            tempPdfPath = path.join(process.cwd(), `temp_ocr_${timestamp}_${pageNumber}.pdf`);
            await fs.writeFile(tempPdfPath, pdfBuffer);
            
            this.log(`    Converting page ${pageNumber} to image...`, 'debug');
            
            // Convert specific page to PNG - use relative path for output
            const pngPages = await pdfToPng(tempPdfPath, {
                disableFontFace: false,
                useSystemFonts: false,
                viewportScale: 2.0,
                outputFolder: '.', // Use current directory
                strictPagesToProcess: false,
                pagesToProcess: [pageNumber],
                outputFileMask: `page_${timestamp}_${pageNumber}`,
                pdfFilePassword: ''
            });
            
            this.log(`    Conversion result: ${pngPages ? pngPages.length : 0} images generated`, 'debug');
            
            if (pngPages && pngPages.length > 0 && pngPages[0].content) {
                const imageBuffer = pngPages[0].content;
                this.log(`    Image buffer size: ${imageBuffer.length} bytes`, 'debug');
                
                // Clean up generated PNG file if it exists
                if (pngPages[0].path && fsSync.existsSync(pngPages[0].path)) {
                    await fs.unlink(pngPages[0].path).catch(() => {});
                }
                
                return imageBuffer;
            }
            
            this.log(`    No image generated for page ${pageNumber}`, 'debug');
            return null;
            
        } catch (error) {
            this.log(`    Error converting page ${pageNumber} to image: ${error.message}`, 'debug');
            return null;
        } finally {
            // Clean up temp PDF
            if (tempPdfPath && fsSync.existsSync(tempPdfPath)) {
                await fs.unlink(tempPdfPath).catch(() => {});
            }
        }
    }
    
    async ocrEntirePdf(pdfBuffer, worker, pageCount) {
        try {
            const pagesData = []; // Store page-by-page data
            const ocrTexts = [];
            let successfulPages = 0;
            
            for (let i = 1; i <= pageCount; i++) {
                this.log(`    OCR processing page ${i}/${pageCount}...`, 'debug');
                
                try {
                    // Convert PDF page to image
                    const imageBuffer = await this.convertPdfPageToImage(pdfBuffer, i);
                    
                    if (!imageBuffer) {
                        this.log(`    Skipping page ${i} - conversion failed`, 'debug');
                        // Add empty page to maintain page numbers
                        pagesData.push({
                            page: i,
                            text: '[Page conversion failed]'
                        });
                        continue;
                    }
                    
                    this.log(`    Image buffer size: ${imageBuffer.length} bytes`, 'debug');
                    
                    // Perform OCR on the image
                    const result = await worker.recognize(imageBuffer);
                    const text = result.data.text;
                    
                    this.log(`    OCR extracted ${text ? text.length : 0} characters`, 'debug');
                    
                    if (text && text.trim().length > 10) {
                        const cleanedText = text.trim();
                        pagesData.push({
                            page: i,
                            text: cleanedText
                        });
                        ocrTexts.push(cleanedText);
                        successfulPages++;
                    } else {
                        this.log(`    Page ${i} OCR returned minimal text`, 'debug');
                        pagesData.push({
                            page: i,
                            text: text ? text.trim() : '[No text on this page]'
                        });
                    }
                } catch (pageError) {
                    this.log(`    OCR failed for page ${i}: ${pageError.message}`, 'debug');
                    pagesData.push({
                        page: i,
                        text: '[OCR failed for this page]'
                    });
                }
            }
            
            this.log(`  OCR completed: ${successfulPages}/${pageCount} pages successful`, 'debug');
            
            if (ocrTexts.length === 0) {
                this.log('  WARNING: No text extracted from any page', 'debug');
            }
            
            return {
                fullText: ocrTexts.join('\n\n'),
                pages: pagesData
            };
        } catch (error) {
            this.log('  Full PDF OCR failed: ' + error.message, 'debug');
            return {
                fullText: '',
                pages: []
            };
        }
    }
    
    async ocrPdfPages(pdfBuffer, worker, pageCount) {
        try {
            // Similar to ocrEntirePdf - OCR each page individually
            return await this.ocrEntirePdf(pdfBuffer, worker, pageCount);
        } catch (error) {
            this.log('  Image OCR failed: ' + error.message, 'debug');
            return {
                fullText: '',
                pages: []
            };
        }
    }
    
    async cleanupTempFiles() {
        try {
            const currentDir = process.cwd();
            const files = await fs.readdir(currentDir);
            const tempFiles = files.filter(f => 
                f.startsWith('temp_') || 
                f.startsWith('temp_ocr_') || 
                f.startsWith('page_')
            );
            
            if (tempFiles.length > 0) {
                this.log(`\nCleaning up ${tempFiles.length} temporary files...`);
                for (const file of tempFiles) {
                    try {
                        await fs.unlink(path.join(currentDir, file));
                    } catch (e) {
                        // Ignore errors
                    }
                }
            }
        } catch (error) {
            // Ignore cleanup errors
        }
    }

    cleanText(text) {
        if (!text) return '';
        
        // Replace multiple spaces with single space
        text = text.replace(/ +/g, ' ');
        // Replace multiple newlines with double newline
        text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
        // Remove leading/trailing whitespace from each line
        const lines = text.split('\n').map(line => line.trim());
        return lines.join('\n');
    }

    splitIntoPages(fullText, pageCount) {
        // Legacy fallback only when direct page extraction fails unexpectedly.
        const pages = [];
        
        if (!fullText || pageCount === 0) {
            return pages;
        }
        
        const lines = fullText.split('\n');
        const linesPerPage = Math.ceil(lines.length / pageCount);
        
        for (let i = 0; i < pageCount; i++) {
            const start = i * linesPerPage;
            const end = Math.min((i + 1) * linesPerPage, lines.length);
            const pageText = lines.slice(start, end).join('\n');
            
            if (pageText.trim()) {
                pages.push({
                    page: i + 1,
                    text: pageText
                });
            }
        }
        
        return pages;
    }

    extractSubject(text, language = 'english') {
        const lines = text.split('\n');
        
        // Strategy 1: Standard format with "INFORMATION NOTE" header
        // Strategy 2: Fallback - find subject between metadata block and "To:" line
        
        const subjectLines = [];
        let infoNoteIndex = -1;
        let toLineIndex = -1;
        
        // Language-specific patterns
        const isChineseDoc = language === 'chinese';
        const toPattern = isChineseDoc ? /^致\s*[：:]/i : /^To\s*:/i;
        const englishHeaderPattern = /HONG KONG MERCHANT SHIPPING INFORMATION NOTE\s*$/i;
        const chineseHeaderPattern = /香\s*港\s*商\s*船\s*資\s*訊\s*$/i;
        
        // First pass: Find "INFORMATION NOTE" header and "To:" line
        // Prioritize language-appropriate header
        for (let i = 0; i < lines.length; i++) {
            const lineStripped = lines[i].trim();
            
            if (isChineseDoc) {
                // For Chinese docs, prioritize Chinese header
                if (infoNoteIndex === -1 && chineseHeaderPattern.test(lineStripped)) {
                    infoNoteIndex = i;
                }
                // Accept English header as fallback
                else if (infoNoteIndex === -1 && englishHeaderPattern.test(lineStripped)) {
                    infoNoteIndex = i;
                }
            } else {
                // For English docs, prioritize English header
                if (infoNoteIndex === -1 && englishHeaderPattern.test(lineStripped)) {
                    infoNoteIndex = i;
                }
                // Accept Chinese header as fallback
                else if (infoNoteIndex === -1 && chineseHeaderPattern.test(lineStripped)) {
                    infoNoteIndex = i;
                }
            }
            
            // Find "To:" or "致：" line
            if (toPattern.test(lineStripped)) {
                toLineIndex = i;
                break;
            }
        }
        
        // Strategy 1: Standard format with header
        if (infoNoteIndex >= 0 && toLineIndex > infoNoteIndex) {
            // Capture lines between header and "To:"
            for (let i = infoNoteIndex + 1; i < toLineIndex; i++) {
                const lineStripped = lines[i].trim();
                
                // Skip empty lines
                if (!lineStripped) continue;
                
                // Skip the English header if it appears after Chinese header (with or without OCR noise)
                if (englishHeaderPattern.test(lineStripped)) continue;
                
                // Skip the Chinese header if it appears again
                if (chineseHeaderPattern.test(lineStripped)) continue;
                
                // Skip standalone MSIN number lines
                if (/^MSIN\s+No\.\s*\d+\/\d{4}$/i.test(lineStripped)) continue;
                
                // Skip standalone date patterns like "1/2026"
                if (/^\d+\/\d{4}$/i.test(lineStripped)) continue;
                
                // Skip "No. :" or "No:" or "編號 :" lines
                if (/^(No\.?\s*[：:]|編號\s*[：:])\s*$/i.test(lineStripped)) continue;
                
                // Skip lines that are just OCR noise (single characters, symbols)
                if (/^[^\w\s]{1,3}$/.test(lineStripped)) continue;
                
                // Add to subject
                subjectLines.push(lineStripped);
            }
        }
        // Strategy 2: Fallback - no standard header found
        else if (infoNoteIndex === -1 && toLineIndex > 0) {
            // Work backwards from "To:" line to find where subject starts
            // Subject typically comes after a blank line following metadata
            
            let subjectStartIndex = -1;
            let foundContentLine = false;
            
            // Scan backwards from "To:" line
            for (let i = toLineIndex - 1; i >= 0; i--) {
                const lineStripped = lines[i].trim();
                
                // Skip empty lines at the end (just before "To:")
                if (!lineStripped) {
                    if (foundContentLine) {
                        // Empty line after content - this separates subject from metadata
                        subjectStartIndex = i + 1;
                        break;
                    }
                    continue;
                }
                
                // Check if this looks like metadata (contact info, addresses) - both English and Chinese
                const isMetadata = /^(Marine Department|Harbour Building|Pier Road|G\.P\.O\.|Box \d+|Hong Kong|Telephone|Fax|E-mail|Web site|https?:\/\/|No\.?\s*[：:]|MSIN\s+No\.|^\d+\/\d{4}$|香港商船資訊|海事處|統一碼頭道|香港郵政總局|電話|傳真|電郵|網站|編號)/i.test(lineStripped);
                
                if (isMetadata) {
                    // We've hit metadata, so subject starts after this block
                    subjectStartIndex = i + 1;
                    break;
                }
                
                // This line looks like content (not metadata)
                foundContentLine = true;
            }
            
            // If we found where subject starts, collect those lines
            if (subjectStartIndex > 0) {
                for (let i = subjectStartIndex; i < toLineIndex; i++) {
                    const lineStripped = lines[i].trim();
                    if (lineStripped) {
                        // Skip OCR noise
                        if (/^[^\w\s]{1,3}$/.test(lineStripped)) continue;
                        subjectLines.push(lineStripped);
                    }
                }
            }
        }
        
        if (subjectLines.length > 0) {
            let subject = subjectLines.join(' ');
            
            // Clean up OCR noise at the beginning
            // Remove patterns like "人 S " or other single char + space combinations at start
            subject = subject.replace(/^[\u4e00-\u9fff\s]{1,5}[A-Z]\s+/, '');
            
            return subject;
        }
        
        return 'Not specified';
    }

    extractIssuedBy(text, language = 'english') {
        const isChineseDoc = language === 'chinese';
        
        // Language-specific patterns
        const patterns = isChineseDoc ? [
            /海事處處長/i,
            /海事處/i,
            /簽署\s*[：:]\s*([^\n]+)/i,
            /發出\s*[：:]\s*([^\n]+)/i,
            // Fallback to English patterns
            /Director of Marine/i,
            /Marine Department/i,
            /Issued by[:\s]+([^\n]+)/i,
            /Signed[:\s]+([^\n]+)/i
        ] : [
            /Director of Marine/i,
            /Marine Department/i,
            /Issued by[:\s]+([^\n]+)/i,
            /Signed[:\s]+([^\n]+)/i,
            // Fallback to Chinese patterns
            /海事處處長/i,
            /海事處/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return match[1] ? match[1].trim() : match[0].trim();
            }
        }
        
        return 'Not specified';
    }

    extractEffectiveDate(text, language = 'english') {
        const isChineseDoc = language === 'chinese';
        
        // Language-specific patterns
        const patterns = isChineseDoc ? [
            // Chinese date patterns
            /生效日期\s*[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/i,
            /由\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*生效/i,
            /生效\s*[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/i,
            // Fallback to Western format
            /生效日期\s*[：:]\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
            /Effective\s+(?:date|from)[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
            /Effective[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i,
            /With effect from[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i
        ] : [
            // English date patterns
            /Effective\s+(?:date|from)[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
            /Effective[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i,
            /With effect from[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
            // Fallback to Chinese format
            /生效日期\s*[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/i,
            /由\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*生效/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                try {
                    // Handle Chinese date format (YYYY年MM月DD日)
                    if (match.length === 4 && match[1] && match[2] && match[3]) {
                        const year = match[1];
                        const month = String(match[2]).padStart(2, '0');
                        const day = String(match[3]).padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    }
                    
                    // Handle Western date format
                    const parsed = new Date(match[1]);
                    if (!isNaN(parsed.getTime())) {
                        // Use local date components to avoid timezone issues
                        const year = parsed.getFullYear();
                        const month = String(parsed.getMonth() + 1).padStart(2, '0');
                        const day = String(parsed.getDate()).padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    }
                } catch (e) {
                    // Continue to next pattern
                }
            }
        }
        
        return 'Not specified';
    }

    extractSummary(text, language = 'english') {
        const lines = text.split('\n');
        const summaryLines = [];
        let inSummary = false;
        
        const isChineseDoc = language === 'chinese';
        
        // Language-specific patterns
        const summaryHeaderPattern = isChineseDoc ? /^(概要|摘要|Summary)\s*$/i : /^(Summary|概要|摘要)\s*$/i;
        const stopPatterns = isChineseDoc ? [
            /^\d+\s*[.．、]/,  // Chinese numbered sections
            /^(背景|目的|引言|事件經過|經驗教訓|附件|Background|Purpose|Introduction|The Incident|Lessons Learnt)/i
        ] : [
            /^\d+\./,  // English numbered sections
            /^(Background|Purpose|Introduction|The Incident|Lessons Learnt|背景|事件經過|經驗教訓)/i
        ];
        
        for (let i = 0; i < lines.length; i++) {
            const lineStripped = lines[i].trim();
            
            // Start capturing when we find "Summary" or "概要" header
            if (summaryHeaderPattern.test(lineStripped)) {
                inSummary = true;
                continue;
            }
            
            if (inSummary) {
                // Stop at numbered sections or other major headers
                let shouldStop = false;
                for (const stopPattern of stopPatterns) {
                    if (stopPattern.test(lineStripped)) {
                        shouldStop = true;
                        break;
                    }
                }
                if (shouldStop) break;
                
                // Skip empty lines at the start
                if (summaryLines.length === 0 && !lineStripped) {
                    continue;
                }
                
                // Add line to summary
                if (lineStripped) {
                    summaryLines.push(lineStripped);
                } else if (summaryLines.length > 0) {
                    // Preserve paragraph breaks
                    summaryLines.push('');
                }
            }
        }
        
        if (summaryLines.length > 0) {
            // Join lines and clean up multiple blank lines
            let summary = summaryLines.join('\n');
            summary = summary.replace(/\n\s*\n\s*\n+/g, '\n\n');
            return summary.trim();
        }
        
        // Fallback: extract first 500-1000 characters of body text
        // Skip header lines and metadata to find actual content
        const bodyLines = [];
        let foundContent = false;
        
        // Language-specific metadata patterns
        const metadataPattern = isChineseDoc ? 
            /^(香港商船資訊|HONG KONG MERCHANT SHIPPING|MSIN No\.|編號\s*[：:]|致\s*[：:]|海事處|統一碼頭道|香港郵政總局|To\s*:|Marine Department|Harbour Building)/i :
            /^(HONG KONG MERCHANT SHIPPING|香港商船資訊|MSIN No\.|No\.\s*:|To\s*:|Marine Department|Harbour Building)/i;
        
        for (const line of lines) {
            const lineStripped = line.trim();
            if (!lineStripped) continue;
            
            // Skip common header/metadata patterns
            if (metadataPattern.test(lineStripped)) {
                continue;
            }
            
            // Start capturing after we see numbered sections or substantive content
            if (/^[1-9][\s.．、]/.test(lineStripped) || lineStripped.length > 50) {
                foundContent = true;
            }
            
            if (foundContent) {
                bodyLines.push(lineStripped);
            }
        }
        
        if (bodyLines.length > 0) {
            const bodyText = bodyLines.join(' ');
            // Return 500-1000 characters, trying to end at a sentence boundary
            if (bodyText.length <= 1000) {
                return bodyText;
            }
            
            // Find a good break point between 500-1000 chars
            let endPos = 1000;
            // For Chinese, look for Chinese period (。) or English period
            const sentenceEnd = isChineseDoc ? 
                Math.max(bodyText.lastIndexOf('。', 1000), bodyText.lastIndexOf('.', 1000)) :
                bodyText.lastIndexOf('.', 1000);
            
            if (sentenceEnd > 500) {
                endPos = sentenceEnd + 1;
            }
            
            return bodyText.slice(0, endPos).trim();
        }
        
        return 'Not specified';
    }

    extractAttachmentsFromPdf(text) {
        // This method is kept for reference but not used in final output
        // Attachments are extracted from the website listing instead
        const attachments = [];
        const patterns = [
            /Annex\s+[A-Z0-9]+[:\s\-]+([^\n]+)/gi,
            /Appendix\s+[A-Z0-9]+[:\s\-]+([^\n]+)/gi,
            /Attachment\s+[A-Z0-9]+[:\s\-]+([^\n]+)/gi,
            /Schedule\s+[A-Z0-9]+[:\s\-]+([^\n]+)/gi
        ];
        
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const attachment = match[0].trim();
                if (!attachments.includes(attachment)) {
                    attachments.push(attachment);
                }
            }
        }
        
        return attachments;
    }

    // Extract tables from PDF text using pattern matching
    // Note: pdf-table-extractor library is not compatible with modern Node.js
    async extractTablesFromPdf(pdfBuffer, pdfText) {
        // Use text-based table detection
        return this.extractTablesFromText(pdfText || '');
    }
    
    // Format extracted table data into structured output
    formatExtractedTable(tableData, pageNum, tableNum) {
        if (!tableData || tableData.length === 0) {
            return null;
        }
        
        // Filter out empty rows
        const rows = tableData.filter(row => {
            if (!row || !Array.isArray(row)) return false;
            return row.some(cell => cell && cell.toString().trim().length > 0);
        });
        
        if (rows.length === 0) {
            return null;
        }
        
        // Try to detect header row (first row often contains headers)
        const headerRow = rows[0];
        const dataRows = rows.slice(1);
        
        // Clean cell values
        const cleanCell = (cell) => {
            if (cell === null || cell === undefined) return '';
            return cell.toString().trim().replace(/\s+/g, ' ');
        };
        
        const headers = headerRow.map(cleanCell);
        
        // Build table structure
        const table = {
            page: pageNum,
            table_number: tableNum,
            headers: headers,
            rows: dataRows.map(row => row.map(cleanCell)),
            row_count: dataRows.length,
            column_count: headers.length
        };
        
        // Only return tables with meaningful content
        if (table.row_count === 0 || table.column_count === 0) {
            return null;
        }
        
        // Additional: create a "records" format for easier consumption
        // Each row becomes an object with header keys
        if (headers.every(h => h.length > 0)) {
            table.records = dataRows.map(row => {
                const record = {};
                headers.forEach((header, idx) => {
                    record[header] = cleanCell(row[idx] || '');
                });
                return record;
            });
        }
        
        return table;
    }
    
    // Fallback: Extract tables from text using pattern matching (for OCR'd text)
    extractTablesFromText(text) {
        const tables = [];
        
        // Look for table-like patterns in the text
        // Tables often have:
        // - Lines with multiple tab/space-separated columns
        // - Consistent column alignment
        // - Header rows followed by data rows
        
        const lines = text.split('\n');
        let currentTable = null;
        let tableStartIdx = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines
            if (!line) {
                // End current table if we have one
                if (currentTable && currentTable.rows.length > 1) {
                    tables.push(this.finalizeTextTable(currentTable, tableStartIdx));
                }
                currentTable = null;
                continue;
            }
            
            // Check if line looks like a table row (multiple columns separated by 2+ spaces or tabs)
            const columns = line.split(/\s{2,}|\t+/).filter(c => c.trim().length > 0);
            
            if (columns.length >= 2) {
                if (!currentTable) {
                    // Start a new table
                    currentTable = {
                        headers: columns,
                        rows: [],
                        columnCount: columns.length
                    };
                    tableStartIdx = i;
                } else {
                    // Add row to current table if column count is similar (within 1)
                    if (Math.abs(columns.length - currentTable.columnCount) <= 1) {
                        // Normalize column count
                        while (columns.length < currentTable.columnCount) {
                            columns.push('');
                        }
                        currentTable.rows.push(columns.slice(0, currentTable.columnCount));
                    } else {
                        // Column count mismatch - end current table and start new one
                        if (currentTable.rows.length > 0) {
                            tables.push(this.finalizeTextTable(currentTable, tableStartIdx));
                        }
                        currentTable = {
                            headers: columns,
                            rows: [],
                            columnCount: columns.length
                        };
                        tableStartIdx = i;
                    }
                }
            } else {
                // Not a table row - end current table
                if (currentTable && currentTable.rows.length > 0) {
                    tables.push(this.finalizeTextTable(currentTable, tableStartIdx));
                }
                currentTable = null;
            }
        }
        
        // Don't forget the last table
        if (currentTable && currentTable.rows.length > 0) {
            tables.push(this.finalizeTextTable(currentTable, tableStartIdx));
        }
        
        return tables;
    }
    
    finalizeTextTable(tableData, startLine) {
        const table = {
            page: null, // Can't determine page from text
            table_number: null,
            headers: tableData.headers,
            rows: tableData.rows,
            row_count: tableData.rows.length,
            column_count: tableData.columnCount,
            source: 'text_extraction',
            start_line: startLine
        };
        
        // Create records if headers look valid
        if (tableData.headers.every(h => h.length > 0 && h.length < 50)) {
            table.records = tableData.rows.map(row => {
                const record = {};
                tableData.headers.forEach((header, idx) => {
                    record[header] = row[idx] || '';
                });
                return record;
            });
        }
        
        return table;
    }

    async scrapeAll(filterYear = null) {
        this.log('Starting MSIN scraper...');
        if (filterYear) {
            this.log(`Filtering notices for year: ${filterYear}`);
        }
        if (this.options.incremental) {
            this.log('Incremental mode: will skip already-processed notices');
        }
        this.log(`Concurrency: ${this.options.concurrency} parallel downloads`);
        this.log(`Rate limit: ${this.options.rateLimit}ms between requests`);
        this.log('='.repeat(60));
        
        // Clean up any leftover temp files from previous runs
        await this.cleanupTempFiles();
        
        // Ensure PDF directory exists for local storage
        await this.ensurePdfDirectory();
        
        // Load previous state for incremental scraping
        let state = await this.loadState();
        const startTime = Date.now();
        
        try {
            // Step 1: Scrape index page
            const indexNotices = await this.scrapeIndexPage();
            
            if (!indexNotices || indexNotices.length === 0) {
                this.log('ERROR: No notices found on index page', 'error');
                return null;
            }
            
            // Filter by year if specified
            let filteredNotices = indexNotices;
            if (filterYear) {
                filteredNotices = indexNotices.filter(notice => {
                    // Extract year from notice number (e.g., "MSIN No. 3/2026" -> "2026")
                    const match = notice.noticeNumber.match(/(\d+)\/(\d{4})/);
                    if (match) {
                        const noticeYear = match[2];
                        return noticeYear === filterYear.toString();
                    }
                    return false;
                });
                
                this.log(`\nFiltered ${filteredNotices.length} notices for year ${filterYear} (out of ${indexNotices.length} total)`);
                
                if (filteredNotices.length === 0) {
                    this.log(`\nNo notices found for year ${filterYear}`);
                    return {
                        source_url: this.baseUrl,
                        scraped_at: new Date().toISOString(),
                        filter_year: filterYear,
                        total_notices: 0,
                        notices: []
                    };
                }
            }
            
            // Separate notices into already-processed and to-process
            let noticesToProcess = filteredNotices;
            let skippedNotices = [];
            
            if (this.options.incremental) {
                noticesToProcess = filteredNotices.filter(n => !this.isNoticeProcessed(state, n.noticeNumber));
                skippedNotices = filteredNotices.filter(n => this.isNoticeProcessed(state, n.noticeNumber));
                
                if (skippedNotices.length > 0) {
                    this.log(`\n✓ Skipping ${skippedNotices.length} already-processed notices`);
                }
            }
            
            this.log(`\nProcessing ${noticesToProcess.length} PDFs...`);
            this.log('='.repeat(60));
            
            // Step 2: Process notices (with parallel downloads)
            const allNotices = [];
            
            // First, add back the skipped notices from previous state
            for (const notice of skippedNotices) {
                const cached = state.processedNotices[notice.noticeNumber];
                if (cached && cached.data) {
                    allNotices.push(cached.data);
                    this.log(`  [cached] ${notice.noticeNumber}`, 'debug');
                }
            }
            
            // Process new notices in parallel batches
            const totalToProcess = noticesToProcess.length;
            let processedCount = 0;
            
            const processNotice = async (notice, idx) => {
                const globalIdx = skippedNotices.length + idx + 1;
                processedCount++;
                this.log(`\n[${processedCount}/${totalToProcess}] Processing: ${notice.noticeNumber}`);
                
                try {
                    // Process English version
                    const enPdfData = await this.downloadAndParsePdf(notice.pdfUrl);
                    
                    // Try to get Chinese version
                    const cnPdfUrl = this.getChinesePdfUrl(notice.pdfUrl);
                    let cnPdfData = null;
                    
                    if (cnPdfUrl) {
                        this.log(`  Checking for Chinese version...`, 'debug');
                        try {
                            // Use silent mode - Chinese versions often don't exist for older notices
                            cnPdfData = await this.downloadAndParsePdf(cnPdfUrl, { silent: true });
                            if (cnPdfData) {
                                this.log(`  ✓ Chinese version found`);
                            }
                        } catch (cnError) {
                            // Chinese version not available - this is normal
                            this.log(`  Chinese version not available`, 'debug');
                        }
                    }
                    
                    if (enPdfData) {
                        // Save English PDF locally
                        const enFilename = this.generatePdfFilename(notice.noticeNumber, 'en');
                        const enLocalPath = await this.savePdfLocally(enPdfData.pdfBuffer, enFilename);
                        this.log(`  ✓ Saved: ${enFilename}`);
                        
                        // Build languages array
                        const languages = [{
                            lang: 'en',
                            pdf_url: notice.pdfUrl,
                            local_path: enLocalPath,
                            page_count: enPdfData.pageCount,
                            subject: enPdfData.subject,
                            issued_by: enPdfData.issuedBy,
                            effective_date: enPdfData.effectiveDate,
                            summary: enPdfData.summary,
                            pages: enPdfData.pages,
                            full_text: enPdfData.fullText,
                            tables: enPdfData.tables || []
                        }];
                        
                        // Add Chinese version if available
                        if (cnPdfData && cnPdfUrl) {
                            const cnFilename = this.generatePdfFilename(notice.noticeNumber, 'cn');
                            const cnLocalPath = await this.savePdfLocally(cnPdfData.pdfBuffer, cnFilename);
                            this.log(`  ✓ Saved: ${cnFilename}`);
                            
                            languages.push({
                                lang: 'cn',
                                pdf_url: cnPdfUrl,
                                local_path: cnLocalPath,
                                page_count: cnPdfData.pageCount,
                                subject: cnPdfData.subject,
                                issued_by: cnPdfData.issuedBy,
                                effective_date: cnPdfData.effectiveDate,
                                summary: cnPdfData.summary,
                                pages: cnPdfData.pages,
                                full_text: cnPdfData.fullText,
                                tables: cnPdfData.tables || []
                            });
                        }
                        
                        // Merge index data with PDF data
                        const completeNotice = {
                            id: globalIdx,
                            notice_number: notice.noticeNumber,
                            title: notice.title,
                            issue_date: notice.issueDate,
                            // Keep original fields for backward compatibility (from English version)
                            pdf_url: notice.pdfUrl,
                            local_path: enLocalPath,
                            page_count: enPdfData.pageCount,
                            subject: enPdfData.subject,
                            issued_by: enPdfData.issuedBy,
                            effective_date: enPdfData.effectiveDate,
                            summary: enPdfData.summary,
                            pages: enPdfData.pages,
                            full_text: enPdfData.fullText,
                            tables: enPdfData.tables || [],
                            attachments: notice.attachmentsFromWeb || [],
                            // New: languages array with both versions
                            languages: languages
                        };
                        
                        // Save to state for incremental scraping
                        state.processedNotices[notice.noticeNumber] = {
                            status: 'done',
                            processedAt: new Date().toISOString(),
                            data: completeNotice
                        };
                        await this.saveStateThrottled(state);
                        
                        return completeNotice;
                    } else {
                        // Add placeholder for failed PDF
                        const completeNotice = {
                            id: globalIdx,
                            notice_number: notice.noticeNumber,
                            title: notice.title,
                            issue_date: notice.issueDate,
                            pdf_url: notice.pdfUrl,
                            local_path: null,
                            page_count: 0,
                            subject: 'PDF extraction failed - manual review required',
                            issued_by: 'Not specified',
                            effective_date: 'Not specified',
                            summary: 'PDF extraction failed - manual review required',
                            pages: [],
                            full_text: 'PDF extraction failed - manual review required',
                            tables: [],
                            attachments: notice.attachmentsFromWeb || [],
                            languages: []
                        };
                        
                        // Mark as failed in state (so we retry next time)
                        state.processedNotices[notice.noticeNumber] = {
                            status: 'failed',
                            processedAt: new Date().toISOString(),
                            error: 'PDF extraction failed'
                        };
                        await this.saveStateThrottled(state);
                        
                        return completeNotice;
                    }
                } catch (error) {
                    this.log(`  Error processing notice: ${error.message}`, 'error');
                    // Add placeholder for error
                    const completeNotice = {
                        id: globalIdx,
                        notice_number: notice.noticeNumber,
                        title: notice.title,
                        issue_date: notice.issueDate,
                        pdf_url: notice.pdfUrl,
                        local_path: null,
                        page_count: 0,
                        subject: 'PDF extraction failed - manual review required',
                        issued_by: 'Not specified',
                        effective_date: 'Not specified',
                        summary: 'PDF extraction failed - manual review required',
                        pages: [],
                        full_text: 'PDF extraction failed - manual review required',
                        tables: [],
                        attachments: notice.attachmentsFromWeb || [],
                        languages: []
                    };
                    
                    // Mark as failed in state
                    state.processedNotices[notice.noticeNumber] = {
                        status: 'failed',
                        processedAt: new Date().toISOString(),
                        error: error.message
                    };
                    await this.saveStateThrottled(state);
                    
                    return completeNotice;
                }
            };
            
            // Process with proper concurrency control
            const newNotices = await this.processWithConcurrency(noticesToProcess, processNotice);
            allNotices.push(...newNotices.filter(n => n !== null));
            
            // Final state save (immediate, not throttled)
            await this.saveState(state);
            
            // Deduplicate by notice_number (safety check)
            const uniqueNoticesMap = new Map();
            for (const notice of allNotices) {
                if (!uniqueNoticesMap.has(notice.notice_number)) {
                    uniqueNoticesMap.set(notice.notice_number, notice);
                }
            }
            const uniqueNotices = Array.from(uniqueNoticesMap.values());
            
            if (uniqueNotices.length < allNotices.length) {
                this.log(`  Removed ${allNotices.length - uniqueNotices.length} duplicate entries`);
            }
            
            // Sort by ID to maintain order
            uniqueNotices.sort((a, b) => {
                // Extract year and number from notice_number for proper sorting
                const parseNotice = (n) => {
                    const match = n.notice_number.match(/(\d+)\/(\d{4})/);
                    return match ? { num: parseInt(match[1]), year: parseInt(match[2]) } : { num: 0, year: 0 };
                };
                const aParsed = parseNotice(a);
                const bParsed = parseNotice(b);
                if (aParsed.year !== bParsed.year) return bParsed.year - aParsed.year;
                return bParsed.num - aParsed.num;
            });
            
            // Reassign IDs after sorting
            uniqueNotices.forEach((notice, idx) => {
                notice.id = idx + 1;
            });
            
            // Step 3: Create final output structure
            const output = {
                source_url: this.baseUrl,
                scraped_at: new Date().toISOString(),
                total_notices: uniqueNotices.length,
                notices: uniqueNotices
            };
            
            // Add filter_year to output if filtering was applied
            if (filterYear) {
                output.filter_year = filterYear;
            }
            
            // Update state with completion info
            state.lastRun = {
                completedAt: new Date().toISOString(),
                totalProcessed: uniqueNotices.length,
                duration: Math.round((Date.now() - startTime) / 1000)
            };
            await this.saveState(state);
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            this.log(`\nCompleted in ${duration} seconds`);
            
            return output;
        } catch (error) {
            this.log(`Fatal error in scrapeAll: ${error.message}`, 'error');
            throw error;
        }
    }

    async saveToJson(data, filename = 'msin_notices.json') {
        await fs.writeFile(filename, JSON.stringify(data, null, 2), 'utf8');
        console.log('\n' + '='.repeat(60));
        console.log(`✓ Data saved to ${filename}`);
        console.log(`✓ Total notices: ${data.total_notices}`);
        
        if (this.failedPdfs.length > 0) {
            console.log(`\n⚠ ${this.failedPdfs.length} PDFs failed extraction (flagged for manual review)`);
            for (const failed of this.failedPdfs) {
                console.log(`  - ${failed.url}`);
                console.log(`    Error: ${failed.error}`);
            }
        }
    }
}

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let filterYear = null;
    const options = {};
    
    // Parse all flags
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--year' && args[i + 1]) {
            filterYear = parseInt(args[i + 1]);
            if (isNaN(filterYear) || filterYear < 1900 || filterYear > 2100) {
                console.error('Error: Invalid year. Please provide a valid year (e.g., --year 2024)');
                process.exit(1);
            }
            i++; // Skip next arg
        } else if (arg === '--concurrency' && args[i + 1]) {
            options.concurrency = parseInt(args[i + 1]);
            if (isNaN(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
                console.error('Error: Concurrency must be between 1 and 10');
                process.exit(1);
            }
            i++;
        } else if (arg === '--rate-limit' && args[i + 1]) {
            options.rateLimit = parseInt(args[i + 1]);
            if (isNaN(options.rateLimit) || options.rateLimit < 0) {
                console.error('Error: Rate limit must be a positive number (milliseconds)');
                process.exit(1);
            }
            i++;
        } else if (arg === '--no-incremental') {
            options.incremental = false;
        } else if (arg === '--fresh') {
            options.incremental = false;
            options.clearState = true;
        } else if (arg === '--verbose' || arg === '-v') {
            options.verbose = true;
        } else if (arg === '--quiet' || arg === '-q') {
            options.quiet = true;
        }
    }
    
    // Show usage if --help is provided
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node scraper.js [options]');
        console.log('');
        console.log('Options:');
        console.log('  --year YYYY        Filter notices by year (e.g., --year 2024)');
        console.log('  --concurrency N    Number of parallel downloads (1-10, default: 1)');
        console.log('  --rate-limit MS    Delay between requests in ms (default: 1000)');
        console.log('  --no-incremental   Re-download all notices (ignore cache)');
        console.log('  --fresh            Clear state and start fresh');
        console.log('  --verbose, -v      Show detailed progress');
        console.log('  --quiet, -q        Minimal output');
        console.log('  --help, -h         Show this help message');
        console.log('');
        console.log('Examples:');
        console.log('  node scraper.js                        # Scrape all (incremental, sequential)');
        console.log('  node scraper.js --year 2024            # Scrape only 2024 notices');
        console.log('  node scraper.js --concurrency 3        # Use 3 parallel downloads');
        console.log('  node scraper.js --fresh                # Clear cache, start fresh');
        console.log('  node scraper.js --verbose              # Show detailed progress');
        process.exit(0);
    }
    
    const url = 'https://www.mardep.gov.hk/en/legislation/notices/msin/index.html';
    
    const scraper = new MSINScraper(url, options);
    
    // Clear state if --fresh flag is used
    if (options.clearState) {
        await scraper.clearState();
        console.log('✓ State cleared - starting fresh');
    }
    
    try {
        const data = await scraper.scrapeAll(filterYear);
        
        if (data) {
            // Generate filename based on filter
            const filename = filterYear ? `msin_notices_${filterYear}.json` : 'msin_notices.json';
            await scraper.saveToJson(data, filename);
            console.log('\n✓ Scraping completed successfully!');
            
            // Final cleanup
            await scraper.cleanupTempFiles();
            
            process.exit(0);
        } else {
            console.error('\n✗ Scraping failed');
            process.exit(1);
        }
    } catch (error) {
        console.error('\n✗ Fatal error:', error.message);
        console.error(error.stack);
        
        // Cleanup on error
        await scraper.cleanupTempFiles();
        
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = MSINScraper;
