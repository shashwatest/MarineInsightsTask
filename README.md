# MSIN Scraper - Hong Kong Merchant Shipping Information Notes

Robust web scraper that extracts structured data from Hong Kong Marine Department's MSIN notices with OCR support for scanned documents.

## Features

- ✅ Scrapes 697 notices from paginated website (all available as of April 2026)
- ✅ Handles JavaScript-rendered content using Puppeteer
- ✅ OCR support for scanned PDFs (English + Traditional Chinese + Simplified Chinese)
- ✅ Extracts all required fields with high accuracy
- ✅ Page-by-page content extraction with proper boundaries
- ✅ Year filter to scrape specific years only
- ✅ Comprehensive error handling and logging
- ✅ Automatic cleanup of temporary files
- ✅ **Retry mechanism** for failed PDF downloads (3 retries with exponential backoff)
- ✅ **Local PDF storage** in `/pdfs` folder with `local_path` references
- ✅ **Bilingual extraction** - English and Chinese versions linked under one notice
- ✅ **Table extraction** - detects and extracts tables from PDFs as structured data
- ✅ **Incremental scraping** - skip already-downloaded notices on re-runs
- ✅ **Progress persistence** - resume from where you left off after interruption
- ✅ **Parallel downloads** - configurable concurrency (1-10, default: 1)
- ✅ **Rate limiting** - configurable delay between requests (default: 1000ms)
- ✅ **Verbose/Quiet modes** - control logging verbosity

## Installation

1. Install Node.js dependencies:
```bash
npm install
```

This will install:
- `puppeteer` - Browser automation
- `axios` - HTTP requests
- `pdf-parse` - PDF text extraction
- `tesseract.js` - OCR (no additional installation needed!)
- `pdf-lib` - PDF manipulation
- `pdf-to-png-converter` - PDF to image conversion
- `pdf-table-extractor` - Table extraction from PDFs

## Usage

### Scrape all notices (incremental)
```bash
node scraper.js
# or
npm start
```

### Filter by year
```bash
node scraper.js --year 2024
```

### Parallel downloads (faster)
```bash
node scraper.js --concurrency 3    # Use 3 parallel downloads (default: 1 - sequential)
```

### Rate limiting
```bash
node scraper.js --rate-limit 2000  # 2 seconds between requests (default: 1000ms)
```

### Fresh start (ignore cache)
```bash
node scraper.js --fresh            # Clear state and re-download everything
node scraper.js --no-incremental   # Re-download but keep state file
```

### Verbose/Quiet mode
```bash
node scraper.js --verbose          # Show detailed progress
node scraper.js --quiet            # Minimal output
```

### Show help
```bash
node scraper.js --help
```

When filtering by year, the output file will be named `msin_notices_YYYY.json` (e.g., `msin_notices_2024.json`).

## Output

The script generates `msin_notices.json` containing:
- All notice metadata from the index page
- Full text content extracted from each PDF (including OCR text)
- Structured fields including subject, issued_by, effective_date, etc.
- Page-by-page breakdown of PDF content with proper boundaries
- Attachments with names and URLs
- Local PDF file paths (stored in `/pdfs` folder)
- Multi-language support with `languages` array (EN + CN versions linked)

### Output Format

```json
{
  "source_url": "https://www.mardep.gov.hk/en/legislation/notices/msin/index.html",
  "scraped_at": "2026-04-07T07:51:36.088Z",
  "total_notices": 697,
  "notices": [
    {
      "id": 1,
      "notice_number": "MSIN No. 3/2026",
      "title": "Survey Guidelines under the Harmonized System...",
      "issue_date": "2026-02-12",
      "pdf_url": "https://www.mardep.gov.hk/filemanager/...",
      "local_path": "C:/path/to/pdfs/msin_03_2026_en.pdf",
      "page_count": 1,
      "subject": "Survey Guidelines under the Harmonized System...",
      "issued_by": "Marine Department",
      "effective_date": "Not specified",
      "summary": "The purpose of this Note is to advise...",
      "pages": [
        {
          "page": 1,
          "text": "Marine Department\nHarbour Building\n38 Pier Road..."
        }
      ],
      "full_text": "Complete PDF text...",
      "tables": [],
      "attachments": [
        {
          "name": "Annex 1",
          "pdf_url": "https://www.mardep.gov.hk/filemanager/..."
        }
      ],
      "languages": [
        {
          "lang": "en",
          "pdf_url": "https://www.mardep.gov.hk/.../msin2603.pdf",
          "local_path": "C:/path/to/pdfs/msin_03_2026_en.pdf",
          "page_count": 1,
          "subject": "Survey Guidelines...",
          "summary": "The purpose of this Note...",
          "pages": [...],
          "full_text": "...",
          "tables": []
        }
      ]
    }
  ]
}
```

## OCR Support

The scraper automatically detects and handles:
- **Fully scanned PDFs**: Documents that are entirely images
- **Hybrid PDFs**: Documents with both text and embedded images
- **Multi-language**: English, Traditional Chinese, and Simplified Chinese

OCR is triggered automatically when extracted text is sparse (<100 characters).

## Error Handling

PDFs that fail extraction (even after OCR) are flagged with "manual review required" and logged to console. The scraper continues processing remaining documents.

## Performance

- **Total Notices**: 697
- **PDFs Downloaded**: 709 (697 English + 12 Chinese)
- **Success Rate**: 100%
- **Runtime**: ~2-4 hours (depending on concurrency and OCR needs)
- **Output Size**: ~8.4 MB JSON file

## Development Challenges

See [DEVELOPMENT_CHALLENGES.md](DEVELOPMENT_CHALLENGES.md) for detailed documentation of all challenges encountered and how they were solved.

## Project Structure

```
.
├── scraper.js                    # Main scraper implementation
├── package.json                  # Node.js dependencies
├── package-lock.json             # Dependency lock file
├── README.md                     # This file
├── DEVELOPMENT_CHALLENGES.md     # Development documentation
├── MarineInsightsTask.md         # Original requirements
├── msin_notices.json             # Output file (generated)
├── .scraper_state.json           # Progress state for incremental scraping (generated)
└── pdfs/                         # Downloaded PDFs (generated)
    ├── msin_01_2024_en.pdf
    ├── msin_01_2024_cn.pdf
    └── ...
```

## License

This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).

**You may NOT use this software for commercial purposes without explicit written permission.**

For commercial licensing inquiries, please contact the copyright holder.

See the [LICENSE](LICENSE) file for details.
