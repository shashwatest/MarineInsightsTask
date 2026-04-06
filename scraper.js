#!/usr/bin/env node

/**
 * Hong Kong Merchant Shipping Information Notes Scraper (JavaScript/Node.js)
 * Extracts structured data from MSIN notices and their PDFs
 * Includes OCR support for scanned/image-based PDFs
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

class MSINScraper {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.failedPdfs = [];
        this.browser = null;
        this.page = null;
    }

    async initBrowser() {
        console.log('Initializing browser...');
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
            console.error('Failed to initialize browser:', error.message);
            throw error;
        }
    }

    async closeBrowser() {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (error) {
                console.error('Error closing browser:', error.message);
            }
        }
    }

    async scrapeIndexPage() {
        console.log(`Fetching index page: ${this.baseUrl}`);
        
        try {
            await this.initBrowser();
            await this.page.goto(this.baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            console.log('Waiting for page to load...');
            await this.page.waitForTimeout(4000);
            
            const notices = [];
            let pageNum = 1;
            const maxAttempts = 20;
            
            while (pageNum <= maxAttempts) {
                console.log(`Scraping page ${pageNum}...`);
                
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
                
                console.log(`  Found ${pageNotices.length} notices on page ${pageNum}`);
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
                    await this.page.waitForTimeout(3000);
                    pageNum = nextPage;
                } catch (e) {
                    console.log(`  Could not navigate to page ${pageNum + 1}: ${e.message}`);
                    break;
                }
            }
            
            console.log(`Found ${notices.length} total notices across ${pageNum} pages`);
            return notices;
            
        } finally {
            await this.closeBrowser();
        }
    }

    async downloadAndParsePdf(pdfUrl) {
        let worker = null;
        
        try {
            console.log(`Downloading PDF: ${pdfUrl}`);
            
            const response = await axios.get(pdfUrl, {
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
            
            const pdfBuffer = Buffer.from(response.data);
            const data = await pdf(pdfBuffer);
            
            if (!data || !data.text) {
                throw new Error('PDF parsing returned no text');
            }
            
            const pageCount = data.numpages || 0;
            let fullText = this.cleanText(data.text);
            const originalText = fullText; // Keep original text as backup
            let pages = []; // Will store page-by-page data
            
            // Check if text extraction is poor (likely scanned PDF)
            const textIsSparse = !fullText || fullText.trim().length < 100;
            
            if (textIsSparse) {
                console.log('  PDF appears to be scanned or has sparse text - performing OCR...');
                console.log(`  Original text length: ${originalText ? originalText.length : 0} chars`);
                
                // Initialize Tesseract worker with better settings
                worker = await createWorker('eng+chi_tra+chi_sim', 1, {
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            console.log(`    Tesseract progress: ${Math.round(m.progress * 100)}%`);
                        }
                    }
                });
                
                // Perform OCR on entire PDF - returns both fullText and pages
                const ocrResult = await this.ocrEntirePdf(pdfBuffer, worker, pageCount);
                
                if (ocrResult.fullText && ocrResult.fullText.trim().length > 50) {
                    fullText = ocrResult.fullText;
                    pages = ocrResult.pages;
                    console.log(`  OCR successful: extracted ${fullText.length} characters`);
                } else {
                    console.log(`  OCR returned minimal text (${ocrResult.fullText ? ocrResult.fullText.length : 0} chars)`);
                    // Keep original text if OCR failed
                    if (!ocrResult.fullText || ocrResult.fullText.trim().length === 0) {
                        if (originalText && originalText.trim().length > 0) {
                            console.log(`  Keeping original text (${originalText.length} chars)`);
                            fullText = originalText;
                            pages = this.splitIntoPages(fullText, pageCount);
                        } else {
                            console.log(`  WARNING: Both OCR and text extraction failed`);
                            fullText = ocrResult.fullText || originalText || '';
                            pages = ocrResult.pages.length > 0 ? ocrResult.pages : this.splitIntoPages(fullText, pageCount);
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
                    console.log('  PDF contains images - performing OCR on images...');
                    worker = await createWorker('eng+chi_tra+chi_sim', 1, {
                        logger: m => {
                            if (m.status === 'recognizing text') {
                                console.log(`    Tesseract progress: ${Math.round(m.progress * 100)}%`);
                            }
                        }
                    });
                    const ocrResult = await this.ocrPdfPages(pdfBuffer, worker, pageCount);
                    
                    if (ocrResult.fullText && ocrResult.fullText.trim().length > 50) {
                        fullText += '\n\n[OCR from embedded images]\n' + ocrResult.fullText;
                        console.log(`  OCR from images: extracted ${ocrResult.fullText.length} characters`);
                    }
                }
                
                // For normal PDFs, split text into pages
                pages = this.splitIntoPages(fullText, pageCount);
            }
            
            if (!fullText || fullText.trim().length === 0) {
                console.log('  WARNING: No text extracted - PDF may be corrupted or unreadable');
                // Don't throw error, just flag it
                fullText = '[No text could be extracted from this PDF - manual review required]';
                pages = [{
                    page: 1,
                    text: fullText
                }];
            }
            
            if (fullText.trim().length < 50 && fullText.trim().length > 0) {
                console.log(`  WARNING: Very little text extracted (${fullText.trim().length} chars)`);
            }
            
            // Ensure we have pages data
            if (!pages || pages.length === 0) {
                pages = this.splitIntoPages(fullText, pageCount);
            }
            
            // Extract metadata from PDF content
            const subject = this.extractSubject(fullText);
            const issuedBy = this.extractIssuedBy(fullText);
            const effectiveDate = this.extractEffectiveDate(fullText);
            const summary = this.extractSummary(fullText);
            
            return {
                pageCount,
                pages,
                fullText,
                subject,
                issuedBy,
                effectiveDate,
                summary
            };
            
        } catch (error) {
            console.error(`ERROR: Failed to process PDF ${pdfUrl}: ${error.message}`);
            this.failedPdfs.push({ url: pdfUrl, error: error.message });
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
            console.log('  Could not check for images:', error.message);
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
            
            console.log(`    Converting page ${pageNumber} to image...`);
            
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
            
            console.log(`    Conversion result: ${pngPages ? pngPages.length : 0} images generated`);
            
            if (pngPages && pngPages.length > 0 && pngPages[0].content) {
                const imageBuffer = pngPages[0].content;
                console.log(`    Image buffer size: ${imageBuffer.length} bytes`);
                
                // Clean up generated PNG file if it exists
                if (pngPages[0].path && fsSync.existsSync(pngPages[0].path)) {
                    await fs.unlink(pngPages[0].path).catch(() => {});
                }
                
                return imageBuffer;
            }
            
            console.log(`    No image generated for page ${pageNumber}`);
            return null;
            
        } catch (error) {
            console.log(`    Error converting page ${pageNumber} to image:`, error.message);
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
                console.log(`    OCR processing page ${i}/${pageCount}...`);
                
                try {
                    // Convert PDF page to image
                    const imageBuffer = await this.convertPdfPageToImage(pdfBuffer, i);
                    
                    if (!imageBuffer) {
                        console.log(`    Skipping page ${i} - conversion failed`);
                        // Add empty page to maintain page numbers
                        pagesData.push({
                            page: i,
                            text: '[Page conversion failed]'
                        });
                        continue;
                    }
                    
                    console.log(`    Image buffer size: ${imageBuffer.length} bytes`);
                    
                    // Perform OCR on the image
                    const result = await worker.recognize(imageBuffer);
                    const text = result.data.text;
                    
                    console.log(`    OCR extracted ${text ? text.length : 0} characters`);
                    
                    if (text && text.trim().length > 10) {
                        const cleanedText = text.trim();
                        pagesData.push({
                            page: i,
                            text: cleanedText
                        });
                        ocrTexts.push(cleanedText);
                        successfulPages++;
                    } else {
                        console.log(`    Page ${i} OCR returned minimal text`);
                        pagesData.push({
                            page: i,
                            text: text ? text.trim() : '[No text on this page]'
                        });
                    }
                } catch (pageError) {
                    console.log(`    OCR failed for page ${i}: ${pageError.message}`);
                    pagesData.push({
                        page: i,
                        text: '[OCR failed for this page]'
                    });
                }
            }
            
            console.log(`  OCR completed: ${successfulPages}/${pageCount} pages successful`);
            
            if (ocrTexts.length === 0) {
                console.log('  WARNING: No text extracted from any page');
            }
            
            return {
                fullText: ocrTexts.join('\n\n'),
                pages: pagesData
            };
        } catch (error) {
            console.log('  Full PDF OCR failed:', error.message);
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
            console.log('  Image OCR failed:', error.message);
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
                console.log(`\nCleaning up ${tempFiles.length} temporary files...`);
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
        // Since pdf-parse doesn't provide page-by-page text, we'll estimate
        // by splitting the text into roughly equal parts
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

    extractSubject(text) {
        const lines = text.split('\n');
        
        // Strategy 1: Standard format with "INFORMATION NOTE" header
        // Strategy 2: Fallback - find subject between metadata block and "To:" line
        
        const subjectLines = [];
        let infoNoteIndex = -1;
        let toLineIndex = -1;
        
        // First pass: Find "INFORMATION NOTE" header and "To:" line
        // Prioritize English header over Chinese header
        // Handle OCR noise (e.g., "人 S HONG KONG MERCHANT SHIPPING...")
        for (let i = 0; i < lines.length; i++) {
            const lineStripped = lines[i].trim();
            
            // Find English "INFORMATION NOTE" header first (higher priority)
            // Allow for OCR noise before the header
            if (infoNoteIndex === -1 && /HONG KONG MERCHANT SHIPPING INFORMATION NOTE\s*$/i.test(lineStripped)) {
                infoNoteIndex = i;
            }
            // If no English header found yet, accept Chinese header
            else if (infoNoteIndex === -1 && /香\s*港\s*商\s*船\s*資\s*訊\s*$/i.test(lineStripped)) {
                infoNoteIndex = i;
            }
            
            // Find "To:" line (or "To :" with space)
            if (/^To\s*:/i.test(lineStripped)) {
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
                if (/HONG KONG MERCHANT SHIPPING INFORMATION NOTE\s*$/i.test(lineStripped)) continue;
                
                // Skip the Chinese header if it appears again
                if (/^香\s*港\s*商\s*船\s*資\s*訊\s*$/i.test(lineStripped)) continue;
                
                // Skip standalone MSIN number lines
                if (/^MSIN\s+No\.\s*\d+\/\d{4}$/i.test(lineStripped)) continue;
                
                // Skip standalone date patterns like "1/2026"
                if (/^\d+\/\d{4}$/i.test(lineStripped)) continue;
                
                // Skip "No. :" or "No:" lines
                if (/^No\.?\s*:\s*$/i.test(lineStripped)) continue;
                
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
                
                // Check if this looks like metadata (contact info, addresses)
                const isMetadata = /^(Marine Department|Harbour Building|Pier Road|G\.P\.O\.|Box \d+|Hong Kong|Telephone|Fax|E-mail|Web site|https?:\/\/|No\.?\s*:|MSIN\s+No\.|^\d+\/\d{4}$|香港商船資訊)/i.test(lineStripped);
                
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

    extractIssuedBy(text) {
        const patterns = [
            /Director of Marine/i,
            /Marine Department/i,
            /Issued by[:\s]+([^\n]+)/i,
            /Signed[:\s]+([^\n]+)/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return match[1] ? match[1].trim() : match[0].trim();
            }
        }
        
        return 'Not specified';
    }

    extractEffectiveDate(text) {
        const patterns = [
            /Effective\s+(?:date|from)[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
            /Effective[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i,
            /With effect from[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                try {
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

    extractSummary(text) {
        const lines = text.split('\n');
        const summaryLines = [];
        let inSummary = false;
        
        for (let i = 0; i < lines.length; i++) {
            const lineStripped = lines[i].trim();
            
            // Start capturing when we find "Summary" header
            if (/^Summary\s*$/i.test(lineStripped)) {
                inSummary = true;
                continue;
            }
            
            if (inSummary) {
                // Stop at numbered sections (1., 2., etc.) or other major headers
                if (/^\d+\./.test(lineStripped)) {
                    break;
                }
                if (/^(Background|Purpose|Introduction|The Incident|Lessons Learnt)/i.test(lineStripped)) {
                    break;
                }
                
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

    async scrapeAll(filterYear = null) {
        console.log('Starting MSIN scraper...');
        if (filterYear) {
            console.log(`Filtering notices for year: ${filterYear}`);
        }
        console.log('='.repeat(60));
        
        // Clean up any leftover temp files from previous runs
        await this.cleanupTempFiles();
        
        try {
            // Step 1: Scrape index page
            const indexNotices = await this.scrapeIndexPage();
            
            if (!indexNotices || indexNotices.length === 0) {
                console.error('ERROR: No notices found on index page');
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
                
                console.log(`\nFiltered ${filteredNotices.length} notices for year ${filterYear} (out of ${indexNotices.length} total)`);
                
                if (filteredNotices.length === 0) {
                    console.log(`\nNo notices found for year ${filterYear}`);
                    return {
                        source_url: this.baseUrl,
                        scraped_at: new Date().toISOString(),
                        filter_year: filterYear,
                        total_notices: 0,
                        notices: []
                    };
                }
            }
            
            console.log(`\nProcessing ${filteredNotices.length} PDFs...`);
            console.log('='.repeat(60));
            
            // Step 2: Process each PDF
            const allNotices = [];
            for (let idx = 0; idx < filteredNotices.length; idx++) {
                const notice = filteredNotices[idx];
                console.log(`\n[${idx + 1}/${filteredNotices.length}] Processing: ${notice.noticeNumber}`);
                
                try {
                    const pdfData = await this.downloadAndParsePdf(notice.pdfUrl);
                    
                    if (pdfData) {
                        // Merge index data with PDF data
                        const completeNotice = {
                            id: idx + 1,
                            notice_number: notice.noticeNumber,
                            title: notice.title,
                            issue_date: notice.issueDate,
                            pdf_url: notice.pdfUrl,
                            page_count: pdfData.pageCount,
                            subject: pdfData.subject,
                            issued_by: pdfData.issuedBy,
                            effective_date: pdfData.effectiveDate,
                            summary: pdfData.summary,
                            pages: pdfData.pages,
                            full_text: pdfData.fullText,
                            attachments: notice.attachmentsFromWeb || []
                        };
                        allNotices.push(completeNotice);
                    } else {
                        // Add placeholder for failed PDF
                        const completeNotice = {
                            id: idx + 1,
                            notice_number: notice.noticeNumber,
                            title: notice.title,
                            issue_date: notice.issueDate,
                            pdf_url: notice.pdfUrl,
                            page_count: 0,
                            subject: 'PDF extraction failed - manual review required',
                            issued_by: 'Not specified',
                            effective_date: 'Not specified',
                            summary: 'PDF extraction failed - manual review required',
                            pages: [],
                            full_text: 'PDF extraction failed - manual review required',
                            attachments: notice.attachmentsFromWeb || []
                        };
                        allNotices.push(completeNotice);
                    }
                } catch (error) {
                    console.error(`  Error processing notice ${idx + 1}: ${error.message}`);
                    // Add placeholder for error
                    const completeNotice = {
                        id: idx + 1,
                        notice_number: notice.noticeNumber,
                        title: notice.title,
                        issue_date: notice.issueDate,
                        pdf_url: notice.pdfUrl,
                        page_count: 0,
                        subject: 'PDF extraction failed - manual review required',
                        issued_by: 'Not specified',
                        effective_date: 'Not specified',
                        summary: 'PDF extraction failed - manual review required',
                        pages: [],
                        full_text: 'PDF extraction failed - manual review required',
                        attachments: notice.attachmentsFromWeb || []
                    };
                    allNotices.push(completeNotice);
                }
            }
            
            // Step 3: Create final output structure
            const output = {
                source_url: this.baseUrl,
                scraped_at: new Date().toISOString(),
                total_notices: allNotices.length,
                notices: allNotices
            };
            
            // Add filter_year to output if filtering was applied
            if (filterYear) {
                output.filter_year = filterYear;
            }
            
            return output;
        } catch (error) {
            console.error('Fatal error in scrapeAll:', error.message);
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
    
    // Look for --year flag
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--year' && args[i + 1]) {
            filterYear = parseInt(args[i + 1]);
            if (isNaN(filterYear) || filterYear < 1900 || filterYear > 2100) {
                console.error('Error: Invalid year. Please provide a valid year (e.g., --year 2024)');
                process.exit(1);
            }
            break;
        }
    }
    
    // Show usage if --help is provided
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node scraper.js [--year YYYY]');
        console.log('');
        console.log('Options:');
        console.log('  --year YYYY    Filter notices by year (e.g., --year 2024)');
        console.log('  --help, -h     Show this help message');
        console.log('');
        console.log('Examples:');
        console.log('  node scraper.js              # Scrape all notices');
        console.log('  node scraper.js --year 2024  # Scrape only 2024 notices');
        process.exit(0);
    }
    
    const url = 'https://www.mardep.gov.hk/en/legislation/notices/msin/index.html';
    
    const scraper = new MSINScraper(url);
    
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
