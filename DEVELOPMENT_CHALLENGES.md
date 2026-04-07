# Development Challenges & Solutions

This document chronicles the real challenges I faced while building this scraper and how I solved them.

---

The website uses JavaScript to load content dynamically. When I first tried scraping with basic HTTP requests, I got back an empty HTML shell with zero notices. Switched to Puppeteer which actually runs a browser and executes the JavaScript. Added a 4 second wait after page load to make sure everything rendered properly before trying to scrape.

---

Got the first page fine but couldn't figure out why pagination wasn't working. Turns out the "Next" button doesn't use normal links - it calls a JavaScript function whatsNewObj.goToPage(). Had to use page.evaluate() to call that function directly from Puppeteer. Now loops through all pages until it stops finding new data.

---

I misunderstood what some fields should contain. Title should come from the website listing, not the PDF. Subject is the full multi-line heading from inside the PDF between "INFORMATION NOTE" and "To:", not just the first line. Summary should be the actual "Summary" section from the PDF, not just the first 500 characters of random text. Attachments are the extra PDF links on the website, not text mentions inside the PDF. Had to rewrite all the extraction logic once I understood the actual requirements.

---

About 13 PDFs were completely scanned images with no extractable text. pdf-parse would return empty strings. Implemented OCR using Tesseract.js with support for English, Traditional Chinese, and Simplified Chinese. The scraper now checks if extracted text is too short (under 100 chars) and automatically triggers OCR if needed.

---

Tesseract can't read PDF files directly, only images. Got "Error attempting to read image" when trying to pass PDF buffers. Had to add a conversion step: save PDF to temp file, use pdf-to-png-converter to turn each page into a PNG, pass the PNG buffer to Tesseract, then clean up the temp files. Works now but adds extra processing time.

---

On Windows, got weird path errors like "ENOENT: no such file or directory, mkdir 'C:\Users\...\C:\Users\...'" where the path was duplicated. The pdf-to-png-converter was concatenating paths incorrectly when I used __dirname. Changed to process.cwd() and used relative path '.' for the output folder. Fixed the duplication issue.

---

Initially tried using the canvas package for PDF rendering but it needs Visual Studio build tools on Windows for native compilation. Didn't want to deal with that. Switched to pdf-to-png-converter which is pure JavaScript and works without any native dependencies. Much easier to install and use.

---

When OCR was running, page boundaries were completely wrong. Content from page 1 would bleed into page 2, etc. The problem was my splitIntoPages() function which tried to estimate page breaks by dividing total text by page count. That's obviously not accurate. Fixed it by OCR'ing each page individually and storing the text with its page number immediately. No more guessing - each page's content is exactly what came from that specific page.

---

Dates were showing up one day earlier than they should. A document dated "20 November 2025" would appear as "2025-11-19" in the output. This was a timezone issue - JavaScript's toISOString() converts to UTC, and if you're in a timezone behind UTC, the date shifts backward. Fixed by using local date components (getFullYear, getMonth, getDate) instead of UTC conversion. Now dates stay correct regardless of timezone.

---

Some notices had wrong subjects extracted. Notice #3 showed just "1 January 2026" instead of the full title. Notices #8 and #9 included "38 Pier Road" which is part of the address header, not the subject. The problem was my pattern matching was too broad and the fallback logic tried to filter metadata by listing every possible pattern, which was fragile. Rewrote it to understand document structure instead. For standard format, look for the exact "INFORMATION NOTE" header line and capture everything until "To:". For non-standard format, work backwards from "To:" to find where metadata ends (contact info, addresses, URLs) and the subject begins. This structural approach is much more robust and doesn't break when new metadata formats appear.

---

The pdf-parse library gives you all the text as one big string without telling you where pages start and end. For non-OCR PDFs, I was using splitIntoPages() which divided text by line count, causing sentences to get cut off mid-way. Page 1 would end with "The vessel was anchored at" and page 2 would start with "the port of Hong Kong". Fixed by using pdf-parse's internal page metadata when available. For OCR PDFs this wasn't an issue since we process each page individually anyway.

---

When running the scraper multiple times, it would re-download all 700+ PDFs every time, which takes hours. Implemented a state persistence system that saves which notices have been processed to .scraper_state.json. On subsequent runs, it checks this file and skips notices that are already done. Added --fresh flag to clear the state and start over if needed. Also added --no-incremental to ignore the cache but keep the state file. Makes development and testing much faster.

---

Downloading 700 PDFs sequentially takes forever. Added concurrency control so you can download multiple PDFs in parallel. Default is still 1 (sequential) to be safe, but you can use --concurrency 3 or higher to speed things up. Also added rate limiting (--rate-limit) to avoid hammering the server too hard. The rate limiter is concurrency-safe using promise chaining to ensure requests are properly spaced out even when running in parallel.

---

Some PDF downloads would fail randomly due to network issues or server timeouts. Added retry logic with exponential backoff - if a download fails, wait 2 seconds and try again, then 4 seconds, then 8 seconds. Three retries total. Also added logic to not retry on permanent errors like 404s. This made the scraper much more reliable for long-running scrapes.

---

The task asked for both English and Chinese versions to be linked together. Most notices only have English, but some have Chinese versions too. The Chinese PDF URL follows a pattern - replace 'e.pdf' with 'c.pdf' or '/en/' with '/tc/'. The scraper now tries to download the Chinese version for every notice (silently, without logging errors) and if it exists, adds it to a languages array alongside the English version. Found 12 notices with Chinese versions.

---

Tried to extract tables from PDFs using pdf-table-extractor but it has compatibility issues with modern Node.js (canvas native dependencies again). Fell back to text-based table detection - looks for lines with multiple columns separated by spaces or tabs, tracks consistent column counts, and builds structured table data. Not perfect but works for simple tables. Most notices don't have tables anyway.

---

The scraper creates temporary files during OCR (temp PDFs and PNGs). If it crashes or gets interrupted, these files stick around. Added cleanup logic that runs at the start and end of scraping to delete any leftover temp files. Looks for files starting with "temp_" or "page_" and removes them.

---

When processing hundreds of PDFs, it's hard to tell what's happening without good logging. Added verbose mode (--verbose) that shows detailed progress including OCR status, file sizes, and extraction details. Also added quiet mode (--quiet) that only shows errors. Default mode shows a good balance of progress info without being overwhelming.

---

The task required storing PDFs locally in a /pdfs folder. Added logic to save each downloaded PDF with a standardized filename (msin_XX_YYYY_lang.pdf) and include the local_path in the JSON output. This way you have both the original URL and the local file reference. The scraper creates the pdfs directory automatically if it doesn't exist.

---

Some notices have attachments like annexes or appendices. These appear as additional PDF links on the website after the main document link. The scraper now extracts all PDF links from each table cell, skips the first one (main document), and stores the rest as attachments with their names and URLs. This gives you a complete picture of all related documents for each notice.
