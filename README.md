# Control Room

An interactive intelligence and investigation mapping system built with Leaflet.js, featuring comprehensive UK data integration.

## Features

### 🗺️ Interactive Mapping
- Dark-themed map interface with multiple base layers (Dark, Grey, Street, Satellite)
- Clustered markers for better performance with large datasets
- Custom entity placement with manual connection drawing
- Connection highlighting with visual pulse effects

### 🏢 Companies House Integration
- Real-time API search for UK companies
- Person with Significant Control (PSC) data visualization
- Company officer tracking
- Filing history integration
- Automated PDF report generation with PSC networks

### 🚇 Transport Network Visualization
- **TfL (Transport for London)**: 600+ stations across Underground, DLR, Tram, Rail, and Overground
- **Route lines**: Color-coded line routes with official TfL branding
- **Line-specific roundel icons**: Authentic TfL roundels for each line (Bakerloo, Central, Circle, District, etc.)
- **UK Airports**: Both UK-specific and global airport databases
- **Seaports**: UK seaport locations
- **Railways**: UK railway network data

### 🏛️ Geographic Data
- **Police Force Areas**: UK police force boundaries and definitions
- **Postcodes**: UK postcode lookup and geolocation (moved to external storage - see Data Setup)

### 🔗 Entity Management
- **Custom Entities**: Place entities with custom icons from 6 categories (people, buildings, financial, vehicles, communication, social)
- **Manual Connections**: Draw connections between entities with custom labels
- **Connection Types**: Officer (purple), PSC (yellow), Manual (green)
- **Smart Icon Selection**: Keyword-based icon suggestion (e.g., "HSBC" → HSBC bank icon)
- **Address Fields**: Store addresses and notes for accurate geolocation

## Data Setup

### Large Datasets (Not Included)
Due to GitHub's file size limitations, the following large datasets have been excluded from this repository:

- `data/postcode_data/` - 3.8 GB (ONSPD postcode database)
- `data/postcodes/` - 74 MB (JSON postcode lookups)
- `data/companies_house_basic_company_data/` - 2.6 GB
- `data/companies_house_subsets/` - 10.6 GB
- `data/psc_by_company/` - 1.4 GB (Person with Significant Control data)
- `data/psc_names/` - 521 MB

These folders contain README.md files explaining where to obtain or regenerate the data if needed.

### Included Data
The following datasets ARE included and required for core functionality:
- TfL station data (`data/underground_map/`)
- TfL route lines (`data/underground_map/underground-live-map-master/bin/london-lines.json`)
- TfL roundel logos (`data/TFL/logos/`)
- Airport definitions (`data/airports.geojson`, `data/airports_simple.geojson`)
- Police force areas (`data/police_force_areas_wgs84.geojson`)
- Sample data files for testing

### Large OSM PBF (Recommended Workflow)
If you have `data/OS Map/great-britain-260211.osm.pbf`, do not load it in-browser.

Generate small themed overlays instead.

Option A (Python 3.11 + pyrosm):
```bash
pip install pyrosm geopandas shapely pyproj
python scripts/build_osm_layers.py --pbf "data/OS Map/great-britain-260211.osm.pbf" --out "data/osm_derived" --simplify 25
```

Option B (Python 3.12 friendly, GDAL backend):
```bash
winget install GISInternals.GDAL
python scripts/build_osm_layers.py --backend ogr --pbf "data/OS Map/great-britain-260211.osm.pbf" --out "data/osm_derived"
```

Automated one-shot setup:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_osm_backend.ps1
```

This creates:
- `data/osm_derived/gb_major_roads.geojson`
- `data/osm_derived/gb_rail_lines.geojson`
- `data/osm_derived/gb_places.geojson`
- `data/osm_derived/manifest.json`

These outputs are intentionally gitignored to keep the repository and GitHub Pages deployment lightweight.

## Installation

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd "Control Room"
   ```

2. (Optional) Set up Companies House API:
   - Get a free API key from https://developer.company-information.service.gov.uk/
   - Create `.env` file: `CH_API_KEY=your_key_here`

3. Serve via local web server:
   ```bash
   # Python 3
   python scripts/dev_server.py
   # or
   python -m http.server 8000
   ```

4. Access at `http://localhost:8000`

## Hosted (No Local Server)

To run from GitHub Pages without `python scripts/dev_server.py`, deploy the Cloudflare Worker proxy:

1. Deploy Worker from `deploy/cloudflare-worker/` (see `deploy/cloudflare-worker/README.md`)
2. Add to `js/api_keys.js`:
   ```js
   window.CONTROL_ROOM_API_BASE = "https://control-room-proxy.<your-subdomain>.workers.dev";
   ```
3. Commit and push frontend changes

This routes `/ch`, `/tfl`, `/signalbox`, `/webtris`, `/postcodes`, `/osplaces`, `/api/flightradar/*`, and related endpoints through the hosted proxy.

Note: `js/api_base.js` includes a default hosted proxy URL fallback, so GitHub Pages works without a local Python server by default.

## Rail Data Subscriptions

If you have Rail Data Marketplace subscriptions, use the local proxy routes:

- `/raildata/health`
- `/raildata/kb/<feed>`

Supported `feed` values are documented in `docs/RAILDATA_INTEGRATION.md`.

Set credentials in `.env` using either:

- `RAILDATA_AUTH_TOKEN`, or
- `RAILDATA_USERNAME` + `RAILDATA_PASSWORD`

See `.env.example` for all supported rail/API variables.

To validate end-to-end quickly:

1. Enable **National Rail** layer in the UI.
2. Open **National Rail Ops**.
3. Use the **RailData quick-check buttons** (Disruptions, Performance, Reference, NaPTAN, NPTG, My Feeds).

## Usage

### Searching Companies
1. Navigate to the **COMPANIES** tab
2. Enter search criteria (name, number, postcode, town, status, SIC code)
3. Click **Search** to query Companies House API
4. Click company entries to view details and place markers on the map
5. Generate PDF reports with **Download Profile** button

### Viewing Transport Networks
1. Navigate to the **LAYERS** tab
2. Toggle layers:
   - **TfL Stations** - Shows all London transport stations with line-specific roundel icons
   - **UK Airports** / **Global Airports**
   - **Seaports** - UK seaport locations
   - **Police Force Areas** - UK police boundaries

### Adding Custom Entities
1. Click the **+ Entity** button or click anywhere on the map
2. Fill in entity details (label, category, icon, address, notes)
3. Click **Place Entity**

### Drawing Connections
1. Click any entity marker
2. Click the **🔗 Connect** button
3. Click the target entity
4. Enter connection label
5. Click **Add Connection**

### Connection Highlighting
- Click any marker to highlight all connected entities
- Connected entities pulse with red circles
- Connections shown in blue
- Auto-clear after 5 seconds or click to clear

## File Structure

```
Control Room/
├── index.html              # Main application
├── css/
│   └── style.css          # Dark theme styling
├── js/
│   ├── map.js             # Core mapping logic
│   ├── config.js          # Configuration
│   ├── ch_api.js          # Companies House API
│   └── icons.js           # Icon definitions
├── data/
│   ├── TFL/               # TfL logos and route data
│   ├── underground_map/   # Station data
│   └── ...                # Geographic datasets
├── gfx/
│   └── map_icons/         # Custom entity icons (33+)
└── scripts/               # Python data processing utilities
```

## Technologies

- **Leaflet.js 1.9.4** - Interactive mapping
- **Leaflet.markercluster 1.5.3** - Marker clustering
- **Companies House API** - UK company data
- **jsPDF** - PDF generation
- **Python** - Data processing

## Browser Compatibility

- Chrome/Edge (recommended)
- Firefox
- Safari

Requires ES6 support.

## License

This project uses data from:
- Companies House (UK Government Open Data License)
- TfL Open Data (Transport for London)
- OpenStreetMap (ODbL)
- Humanitarian OpenStreetMap Team (HOT)

## Contributing

Contributions welcome! Please open an issue or pull request.
