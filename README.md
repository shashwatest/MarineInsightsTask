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

## Usage

### Scrape all notices
```bash
node scraper.js
# or
npm start
```

### Filter by year
```bash
node scraper.js --year 2024
# or
node scraper.js --year 2025
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
      "attachments": [
        {
          "name": "Annex 1",
          "pdf_url": "https://www.mardep.gov.hk/filemanager/..."
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
└── msin_notices.json             # Output file (generated)
```

## License

This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).

**You may NOT use this software for commercial purposes without explicit written permission.**

For commercial licensing inquiries, please contact the copyright holder.

See the [LICENSE](LICENSE) file for details.
