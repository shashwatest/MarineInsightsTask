# Technical Interview Assignment

## Hong Kong Merchant Shipping Information Notes — Scraper & Structured Data Extraction

### Overview

You are required to build a web scraper that extracts structured data from the following URL:

https://www.mardep.gov.hk/en/legislation/notices/msin/index.html

This page lists approximately 100+ Hong Kong Merchant Shipping Information Notes published by the Hong Kong Marine Department. Each note is a PDF document linked from the page. Your task is to scrape the listing page, download and parse each PDF, extract all relevant content, and compile everything into a single well-structured JSON file.

---

### Objectives

1. Scrape the index page to collect all note entries along with their metadata  
2. Download and extract text content from each linked PDF  
3. Parse and clean the extracted content meaningfully  
4. Compile everything into a single, accurate, and well-structured JSON output  

---

### Requirements

For each Hong Kong Merchant Shipping Information Note listed on the page, you must capture the following fields as a single unified record:

- **notice_number** — the notice identifier, for example MSIN No. 01/2024  
- **title** — the full title of the note as listed on the index page  
- **issue_date** — date of publication  
- **pdf_url** — absolute URL to the PDF file  
- **subject** — subject or heading found inside the PDF, which may differ slightly from the listing title  
- **issued_by** — issuing authority or officer name and designation found inside the PDF  
- **effective_date** — effective date if mentioned inside the PDF  
- **summary** — a clean extracted body text covering the first 500 to 1000 characters of the content  
- **full_text** — complete extracted text from the PDF, cleaned with no excessive whitespace  
- **page_count** — total number of pages in the PDF  
- **attachments** — any appendix or referenced documents mentioned within the PDF  

Each record is a single document. The index page metadata and the PDF content are merged together into one cohesive object with no separation between what was on the listing page and what was inside the PDF.

---

## Output

Output a single JSON file named `msin_notices.json` containing all 100+ records. The JSON must be valid and prettified with an indent of 2.

---

## JSON Output Format

### Top-Level Structure

```json
{
  "source_url": "https://www.mardep.gov.hk/en/legislation/notices/msin/index.html",
  "scraped_at": "2024-11-15T10:30:00Z",
  "total_notices": 102,
  "notices": [ ... ]
}
````

---

### Each Notice Object

```json
{
  "id": 1,
  "notice_number": "MSIN No. 04/2024",
  "title": "Life-Saving Appliances - Immersion Suits and Anti-Exposure Suits",
  "issue_date": "2024-03-12",
  "pdf_url": "https://www.mardep.gov.hk/.../msin2024004e.pdf",
  "page_count": 3,
  "subject": "Life-Saving Appliances - Immersion Suits and Anti-Exposure Suits",
  "issued_by": "Director of Marine",
  "effective_date": "2024-03-12",
  "summary": "This notice draws attention to the requirements under SOLAS Chapter III regarding the carriage and maintenance of immersion suits aboard vessels operating in Hong Kong waters...",
  "pages": [
    {
      "page": 1,
      "text": "HONG KONG MERCHANT SHIPPING INFORMATION NOTE\n\nMSIN No. 04/2024\n\nLIFE-SAVING APPLIANCES - IMMERSION SUITS AND ANTI-EXPOSURE SUITS\n\n1. BACKGROUND\nThis notice is issued to draw the attention of shipowners, masters, and officers to recent amendments made to SOLAS Chapter III regarding immersion suits and anti-exposure suits carried aboard vessels registered in Hong Kong..."
    },
    {
      "page": 2,
      "text": "2. REQUIREMENTS\nAll vessels of 500 GT and above must ensure that immersion suits are serviced at approved service stations at intervals not exceeding 12 months. Suits must be of an approved type and bear the appropriate markings as per MSC.1/Circ.1586.\n\n3. ENFORCEMENT\nMarine inspectors will verify compliance during Port State Control (PSC) inspections. Non-compliant vessels may be subject to detention until deficiencies are rectified..."
    },
    {
      "page": 3,
      "text": "4. FURTHER INFORMATION\nFor any queries regarding this notice, please contact the Hong Kong Marine Department.\n\nANNEX 1 - IMO Circular MSC.1/Circ.1586\nAPPENDIX A - Approved immersion suit manufacturers list\n\nDirector of Marine\nHong Kong Marine Department\n12 March 2024"
    }
  ],
  "full_text": "HONG KONG MERCHANT SHIPPING INFORMATION NOTE\n\nMSIN No. 04/2024\n\nLIFE-SAVING APPLIANCES - IMMERSION SUITS AND ANTI-EXPOSURE SUITS\n\n1. BACKGROUND\nThis notice is issued to draw the attention of shipowners, masters, and officers to recent amendments...\n\n2. REQUIREMENTS\nAll vessels of 500 GT and above must ensure...\n\n3. ENFORCEMENT\nMarine inspectors will verify compliance during Port State Control (PSC) inspections...",
  "attachments": [
    "Annex 1 - IMO Circular MSC.1/Circ.1586",
    "Appendix A - Approved immersion suit manufacturers list"
  ]
}
```

---

## Evaluation Criteria

| Area                 | Weight | What We Look For                                    |
| -------------------- | ------ | --------------------------------------------------- |
| Correctness          | 30%    | Are all 100+ notices captured with accurate fields? |
| PDF Parsing Quality  | 25%    | Is the extracted text clean and meaningful?         |
| Code Quality         | 20%    | Readable, modular, well-commented code              |
| JSON Schema Accuracy | 25%    | Does the output match the required schema exactly?  |

---

## Bonus Points

* Extract notes in both English and Chinese and link them together under one notice object with a languages array
* Detect and extract tables from PDFs where present
* Add a retry mechanism for failed PDF downloads with 3 retries and exponential backoff
* Store PDFs locally in a `/pdfs` folder and reference the local path in the JSON
* Add a CLI flag `--year` to filter scraping by year, for example:
  `python scraper.py --year 2024`