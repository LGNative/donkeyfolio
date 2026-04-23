# Wealthfolio AI Importer Addon

A Wealthfolio addon that extracts transactions from PDFs and images using AI vision models and imports them directly into your portfolio.

## Features

- Upload a PDF or image of a brokerage statement
- AI extracts transactions automatically (OpenAI GPT-5.4-mini or Anthropic Claude)
- Review and edit extracted data before importing
- Import directly into any Wealthfolio account with duplicate detection

## Install

1. Build the addon: `npm run build && npm run bundle`
2. Install `ai-importer.zip` in Wealthfolio via the addon manager

## Development

```bash
npm install
npm run dev:server
```

Enable addon dev mode in Wealthfolio (`VITE_ENABLE_ADDON_DEV_MODE=true`).

## Requirements

An API key from [OpenAI](https://platform.openai.com/api-keys) or [Anthropic](https://console.anthropic.com/).
