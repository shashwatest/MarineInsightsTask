# MSIN Scraper - Hong Kong Merchant Shipping Information Notes

Web scraper that extracts structured data from Hong Kong Marine Department's MSIN notices with OCR support for scanned documents.

## Features

- ✅ Scrapes 937+ notices from paginated website
- ✅ Handles JavaScript-rendered content using Puppeteer
- ✅ OCR support for scanned PDFs (English + Traditional Chinese + Simplified Chinese)
- ✅ Extracts all required fields accurately
- ✅ Year filter to scrape specific years only
- ✅ Comprehensive error handling and logging
- ✅ Automatic cleanup of temporary files
- ✅ **Retry mechanism** for failed PDF downloads (3 retries with exponential backoff)
- ✅ **Local PDF storage** in `/pdfs` folder with `local_path` references
- ✅ **EN/CN language linking** - both versions under one notice with `languages` array
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
- Page-by-page breakdown of PDF content
- Attachments with names and URLs
- Local PDF file paths (stored in `/pdfs` folder)
- Multi-language support with `languages` array (EN + CN versions linked)

### Output Format

```json
{
  "source_url": "https://www.mardep.gov.hk/en/legislation/notices/msin/index.html",
  "scraped_at": "2026-04-07T10:30:00Z",
  "total_notices": 937,
  "notices": [
    {
      "id": 1,
      "notice_number": "MSIN No. 3/2026",
      "title": "Survey Guidelines under the Harmonized System...",
      "issue_date": "2026-02-11",
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
          "text": "HONG KONG MERCHANT SHIPPING INFORMATION NOTE..."
        }
      ],
      "full_text": "Complete PDF text...",
      "tables": [
        {
          "page": 1,
          "table_number": 1,
          "headers": ["Column A", "Column B", "Column C"],
          "rows": [
            ["Row 1 A", "Row 1 B", "Row 1 C"],
            ["Row 2 A", "Row 2 B", "Row 2 C"]
          ],
          "row_count": 2,
          "column_count": 3,
          "records": [
            {"Column A": "Row 1 A", "Column B": "Row 1 B", "Column C": "Row 1 C"},
            {"Column A": "Row 2 A", "Column B": "Row 2 B", "Column C": "Row 2 C"}
          ]
        }
      ],
      "attachments": [
        {
          "name": "Annex 1",
          "pdf_url": "https://www.mardep.gov.hk/filemanager/..."
        }
      ],
      "languages": [
        {
          "lang": "en",
          "pdf_url": "https://www.mardep.gov.hk/.../msin2026003e.pdf",
          "local_path": "C:/path/to/pdfs/msin_03_2026_en.pdf",
          "page_count": 1,
          "subject": "Survey Guidelines...",
          "summary": "The purpose of this Note...",
          "full_text": "...",
          "tables": [...]
        },
        {
          "lang": "cn",
          "pdf_url": "https://www.mardep.gov.hk/.../msin2026003c.pdf",
          "local_path": "C:/path/to/pdfs/msin_03_2026_cn.pdf",
          "page_count": 1,
          "subject": "調查指引...",
          "summary": "本資訊之目的...",
          "full_text": "...",
          "tables": [...]
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

- **Total Notices**: 937
- **Success Rate**: 98.5% (923/937)
- **Runtime**: 3-6 hours (with OCR)
- **Output Size**: ~50MB JSON file

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
