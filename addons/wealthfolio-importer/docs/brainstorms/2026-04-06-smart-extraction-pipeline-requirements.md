---
date: 2026-04-06
topic: smart-extraction-pipeline
---

# Smart Document Extraction Pipeline

## Problem Frame

The current extraction pipeline renders every PDF page as a JPEG image and sends it to the LLM's vision model. This forces the LLM to perform OCR, layout understanding, and data extraction simultaneously. For dense financial tables — small fonts, many columns, tightly packed rows — vision models misread digits, confuse column alignment, and miss rows. Most brokerage statements are digitally generated PDFs with selectable text, so the vision model is doing unnecessary work on the majority of real documents.

## Requirements

- R1. **Document type detection**: When a PDF is uploaded, detect whether each page contains selectable text (native) or is image-only (scanned). Mixed documents are handled per-page.
- R2. **Text extraction for native pages**: For pages with selectable text, extract text content using pdf.js `getTextContent()` and reconstruct the page layout preserving column alignment. Send the reconstructed text to the LLM as structured text input, not as vision/image input.
- R3. **Vision fallback for scanned and garbled pages**: For pages without selectable text (scanned PDFs and uploaded images), continue using the current image-based pipeline. Additionally, auto-detect garbled text extraction (broken font encoding producing non-printable characters) and transparently fall back to image mode for those pages.
- R4. **Smart chunking for large documents**: Split documents that exceed the LLM's context window into chunks (e.g., 5-page batches for text, fewer for image pages), process each chunk independently, then merge and deduplicate results.
- R5. **Confidence flagging**: Validate extracted transactions for suspicious fields (e.g., $0.00 unit price, missing symbol, implausible dates, quantities). Highlight low-confidence fields visually in the review table so the user can inspect and fix them before import.
- R6. **Preserve existing behavior**: The JSON schema, activity types, and post-LLM field validation remain unchanged. The system prompt may be adjusted to handle text vs image input modes. The pipeline changes are upstream of the LLM call (what gets sent) and downstream of validation (how results are displayed).

## Success Criteria

- Native PDF extraction produces fewer misread digits and fewer missed transactions compared to the current image-only pipeline on the same test documents
- Large documents (20+ pages) process successfully via chunking without truncation errors
- Users can quickly identify and fix suspicious fields via visual confidence indicators in the review table
- No new dependencies added — pdf.js (already bundled) handles text extraction

## Scope Boundaries

- **No client-side OCR** — scanned documents continue to use LLM vision directly; adding Tesseract.js or similar is out of scope
- **No automatic retry** — low-confidence fields are flagged for user review, not silently re-sent to the LLM
- **No advanced table parsing** — text extraction uses pdf.js `getTextContent()` with position-based whitespace reconstruction, not dedicated table detection libraries
- **No changes to the JSON schema or activity types** — prompt may be adjusted for text vs image input modes, but the output contract stays the same
- **Single provider call per chunk** — no multi-model ensembles or cross-provider validation

## Key Decisions

- **Text-only for native PDFs, vision-only for scanned**: Separates concerns — specialized tools for text extraction, LLM for semantic understanding. Avoids sending both text and image (expensive) or doing OCR before vision (redundant).
- **pdf.js for text extraction with layout reconstruction**: Already a dependency, has `getTextContent()` API with position data. Use X/Y coordinates to reconstruct whitespace-aligned text that preserves table column structure. No new libraries needed.
- **Auto-detect garbled text, fall back to image**: Some PDFs have selectable text but broken font encoding. Check for high ratio of non-printable characters and transparently switch to image mode for those pages.
- **Flag, don't retry**: For financial data, the user is the final validator. Automatic retries risk introducing different errors silently. Visual confidence flags put the user in control.
- **Smart chunking over page limits**: Removes the current 20-page ceiling and handles large annual statements gracefully. Chunk-and-merge is more robust than relying on ever-larger context windows.

## Dependencies / Assumptions

- pdf.js `getTextContent()` returns usable text for typical brokerage PDFs (digitally generated). Garbled output is handled by the R3 fallback.
- The LLM produces comparable or better results from well-formatted text input as from image input for native PDFs. This is the core bet of the feature.

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R1][Needs research] What heuristic should determine "native vs scanned" per page? Options: check if `getTextContent()` returns non-empty text above a character threshold, or check if the page has embedded fonts.
- [Affects R2][Technical] What Y-coordinate tolerance and X-spacing algorithm works best for reconstructing table layout from pdf.js text items? May need tuning per common brokerage statement formats.
- [Affects R4][Technical] What chunk size balances accuracy and token usage? Need to estimate typical text tokens per page for financial statements and set batch sizes per provider/model.
- [Affects R4][Technical] How should chunk results be merged and deduplicated? Need a dedup key (e.g., date+symbol+amount+type) for transactions that may appear in overlapping chunks or span page boundaries.
- [Affects R1+R4][Technical] When a chunk contains a mix of native and scanned pages, should it be sent as a single mixed-mode request (text + images) or split into separate requests by page type?
- [Affects R5][Technical] What specific validation rules define "low confidence"? Candidates: $0 price, missing symbol, date outside document's apparent date range, quantity of exactly 0.
- [Affects R5][Technical] How should confidence flags appear in the ReviewTable UI — cell-level highlighting, row-level warning icon, or both?
- [Affects R2][Technical] Should text from multi-page chunks preserve page boundaries (e.g., "--- Page 3 ---") to help the LLM understand document structure?

## Next Steps

-> `/ce:plan` for structured implementation planning
