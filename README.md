# Yelp Lead Scraper Automation

Automated lead generation from Yelp with extension-based scraping, Excel export, and time estimation.

---

## ✨ Features

✅ **Extension-Based Scraping** — Uses your modified Yelp scraper extension (avoids bot detection)  
✅ **Automated Pagination** — Scrapes all pages automatically with built-in delays  
✅ **No-Website Filtering** — Returns only leads without a website (highest quality)  
✅ **Excel Export** — Clean, formatted spreadsheet with all business data  
✅ **Time Estimation** — Tracks historical scraping times, shows estimates to clients  
✅ **Web UI** — Beautiful interface for keyword input and progress tracking  
✅ **Real Chrome Browser** — Uses Puppeteer with headed Chrome (not headless) — looks 100% human  

---

## 📋 Prerequisites

1. **Node.js** (v16 or higher) — [Download](https://nodejs.org/)
2. **Yelp Scraper Extension** (modified, no auth) at: `C:\Users\dell\Downloads\crx_extracted\src`
3. **Windows** (for this setup)

---

## 🚀 Installation

### Step 1: Install Dependencies

Open PowerShell in the project folder and run:

```powershell
npm install
```

This will install:
- `express` — Web server
- `puppeteer` — Browser automation
- `excel4node` — Excel file generation
- `axios` — HTTP requests
- `cors` — Cross-origin requests

### Step 2: Verify Extension Path

The server expects the extension at:
```
C:\Users\dell\Downloads\crx_extracted\src
```

If your extension is elsewhere, edit `server.js` line 13:
```javascript
const EXTENSION_PATH = 'C:\\Users\\dell\\Downloads\\crx_extracted\\src';
```

---

## 🎯 Running the Application

### Start the Server

```powershell
npm start
```

You should see:
```
✅ Yelp Scraper Automation running on http://localhost:3000
📁 Extension path: C:\Users\dell\Downloads\crx_extracted\src
💾 Exports directory: C:\Users\dell\yelp-scraper-automation\exports
```

### Open in Browser

Navigate to: **http://localhost:3000**

---

## 💡 How It Works

### User Flow

1. **Enter Details**
   - Keyword: `plumbers`, `dentists`, etc.
   - Location: `New York, NY`, `Chicago`, etc.
   - Yelp Domain: Select country/region

2. **Time Estimate**
   - System checks if you've scraped this keyword before
   - Shows estimated time based on history
   - E.g., "~8 minutes based on 3 previous runs"

3. **Start Scraping**
   - Click "Start Scraping"
   - A real Chrome window opens automatically
   - Extension loads and clicks "Start Auto Extract"
   - Browser navigates to Yelp and starts scraping all pages

4. **Live Progress**
   - UI shows elapsed time
   - Scraping status updates in real-time

5. **Results**
   - Excel file generated automatically
   - **Only businesses WITHOUT a website** are included
   - Download button appears
   - Excel columns: Name | Phone | Address | Category | Rating | Reviews | Lat | Lng

---

## 📊 Data Output

### Excel File Format

| Column | Description |
|--------|-------------|
| Name | Business name |
| Phone | Contact number |
| Address | Full business address |
| Category | Business category (plumber, dentist, etc.) |
| Rating | Yelp star rating (0-5) |
| Reviews | Number of reviews |
| Latitude | GPS coordinate |
| Longitude | GPS coordinate |

**Only rows where `website` field is empty/missing are exported.**

---

## ⏱️ Time Tracking

The system automatically logs scraping times in `timings.json`:

```json
{
  "plumbers|New York, NY": {
    "times": [480, 485, 475],
    "lastRun": "2024-04-20T10:15:32.000Z"
  }
}
```

Next time you scrape the same keyword + location, the UI shows the average time estimate.

---

## 📁 Folder Structure

```
yelp-scraper-automation/
├── server.js              # Main Express server + Puppeteer logic
├── package.json           # Dependencies
├── .env                   # Environment variables
├── timings.json           # Time tracking history
├── public/
│   └── index.html         # Client UI
├── exports/               # Generated Excel files (auto-created)
└── README.md              # This file
```

---

## 🔧 Troubleshooting

### Chrome Window Doesn't Appear

**Problem:** Browser launches but you don't see it.  
**Solution:** The window might be minimized or behind other windows. Check taskbar for Chrome.

### Extension Doesn't Load

**Problem:** "Error: Extension not found"  
**Solution:** Verify the path in `server.js` line 13 matches your extension location.

### Puppeteer Installation Fails

**Problem:** `npm install` errors for puppeteer  
**Solution:** 
```powershell
npm install puppeteer --save
npm install chrome  # If needed
```

### Yelp Blocks the Scraper

**Problem:** Getting 429 (Too Many Requests) errors  
**Solution:** The extension has built-in delays. If it happens:
- Wait 30 minutes before running again (your IP gets rate-limited)
- The extension adds 10-20 second delays between pages — don't remove them

### Excel File Not Generated

**Problem:** Scraping completes but no file downloads  
**Solution:** 
- Check `C:\Users\dell\yelp-scraper-automation\exports\` folder manually
- Check browser console for errors (F12 in Chrome)

---

## 🎓 Example Usage

### Scenario 1: Local Plumber Leads

```
Keyword: plumbers
Location: Denver, Colorado
Yelp Domain: www.yelp.com

Result:
✅ Found 247 total leads
✅ Filtered to 89 leads without website
⏱️ Took 12 minutes
📥 Excel downloaded with 89 plumbers ready to contact
```

### Scenario 2: Repeat Search (Time Estimate)

```
Keyword: plumbers
Location: Denver, Colorado

System shows:
"📊 Time Estimate: ~12 minutes (based on 1 previous run)"

User clicks scrape again
✅ Results in 11 minutes (as estimated!)
```

---

## 🔐 Important Notes

⚠️ **Legal/ToS:** This tool automates the modified extension. Yelp's Terms of Service prohibit automated scraping. Use responsibly and ethically — this is for lead generation research only.

⚠️ **Rate Limiting:** Yelp will block your IP if you make too many requests. The extension has built-in delays — don't bypass them.

⚠️ **Data Privacy:** Only scrape public data that Yelp displays. Don't store or misuse customer information.

---

## 📝 API Endpoints

### GET /api/estimate
Get time estimate for a keyword + location.

```
GET http://localhost:3000/api/estimate?keyword=plumbers&location=Denver
Response:
{
  "estimatedSeconds": 480,
  "runsCount": 3,
  "lastRun": "2024-04-20T10:15:00.000Z"
}
```

### POST /api/scrape
Start a scraping job.

```
POST http://localhost:3000/api/scrape
Body:
{
  "keyword": "plumbers",
  "location": "Denver, Colorado",
  "yelp_domain": "www.yelp.com"
}

Response:
{
  "success": true,
  "leadsTotal": 247,
  "leadsFiltered": 89,
  "elapsedSeconds": 720,
  "filename": "leads_plumbers_Denver_1234567890.xlsx",
  "fileUrl": "/exports/leads_plumbers_Denver_1234567890.xlsx"
}
```

---

## 💬 Support

If you hit issues:
1. Check this README troubleshooting section
2. Check the terminal/console for error messages
3. Verify the extension path is correct
4. Make sure Node.js is installed (`node --version`)

---

## ✅ Quick Start Checklist

- [ ] Node.js installed
- [ ] Extension at `C:\Users\dell\Downloads\crx_extracted\src`
- [ ] Run `npm install`
- [ ] Run `npm start`
- [ ] Open http://localhost:3000
- [ ] Enter keyword and location
- [ ] Click "Start Scraping"
- [ ] Wait for Excel to download

---

**Built with ❤️ for automated lead generation**
