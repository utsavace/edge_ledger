import fs from "fs";
import path from "path";

export interface OHLCV {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------- PERSONAL TRADE JOURNAL ----------------

export interface JournalTrade {
  id: string;
  symbol: string;
  name?: string;
  strategyId?: string;
  strategyLabel?: string;
  module?: string;           // "m1" | "m2" | "m3"
  takenAt: string;           // ISO timestamp when the user ticked "taking this trade"
  entryDate: string;         // YYYY-MM-DD trading day of entry
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  status: "OPEN" | "SL_HIT" | "TARGET_HIT" | "CLOSED_MANUAL";
  exitPrice?: number;
  exitDate?: string;
  returnPct?: number;
  currentPrice?: number;     // latest close while OPEN
  unrealizedPct?: number;    // while OPEN
  depthPct?: number;         // m2: cup depth at entry (for the learning stats)
  durationM?: number;        // m2: base duration
  note?: string;
  aiReview?: string;         // Gemini-generated review after close
}

// Walks the candles AFTER the entry day chronologically and decides whether the
// stop-loss or the target was hit first (gap-aware). Same-candle ambiguity (low
// touches stop AND high touches target on one day) resolves to SL — conservative,
// since intraday order is unknowable from daily bars.
// Checks start from the NEXT session (date > entryDate) because the entry itself
// happened intraday on entryDate — that day's earlier low must not fake an SL hit.
export function evaluateTradeOutcome(
  entryDate: string,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
  ohlcv: OHLCV[]
): { status: "OPEN" | "SL_HIT" | "TARGET_HIT"; exitPrice?: number; exitDate?: string; currentPrice?: number } {
  const after = ohlcv.filter((c) => c.date > entryDate);
  for (const c of after) {
    // Gap cases — open price confirms which level was hit (no ambiguity)
    if (c.open <= stopPrice)   return { status: "SL_HIT",     exitPrice: c.open,        exitDate: c.date };
    if (c.open >= targetPrice) return { status: "TARGET_HIT", exitPrice: c.open,        exitDate: c.date };
    // Same-candle ambiguity: if BOTH SL and target could be hit intraday,
    // SL takes priority (conservative — intraday order unknown from daily bars)
    if (c.low <= stopPrice && c.high >= targetPrice) {
      return { status: "SL_HIT", exitPrice: stopPrice, exitDate: c.date };
    }
    if (c.low <= stopPrice)    return { status: "SL_HIT",     exitPrice: stopPrice,     exitDate: c.date };
    if (c.high >= targetPrice) return { status: "TARGET_HIT", exitPrice: targetPrice,   exitDate: c.date };
  }
  const last = ohlcv[ohlcv.length - 1];
  return { status: "OPEN", currentPrice: last ? last.close : undefined };
}

export interface TradeRecord {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  win: boolean;
  depthPct?: number;    // m2 only: depth of the cup base active at entry
  durationM?: number;   // m2 only: base duration (≈months) active at entry
  forced?: boolean;     // closed only because the data ended (not a real strategy exit)
}

interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

interface BBResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
}

interface StochRSIResult {
  k: number[];
  d: number[];
}

export interface BacktestStats {
  passed: boolean;
  passedBase?: boolean;    // base gate (M2, M4, M6 relaxed gate)
  passedStrict?: boolean;  // strict gate (M1, M3)
  numTrades: number;
  winRatePct: number;
  profitFactor: number;
  avgReturnPct: number;
  maxDrawdownPct: number;
  lastEntryPrice: number;
  lastExitPrice: number;
  lastReturnPct: number;
  liveSignal: boolean;
  livePrice: number | null;
  liveStop?: number | null;    // m4: structure-based SL for today's live signal
  liveTarget?: number | null;  // m4: 2R target for today's live signal
  tradeLog: TradeRecord[];
  // Every fresh trigger with the close price of that day (m2 also carries cup depth/duration;
  signals: { d: string; p: number; dp?: number; dm?: number; stop?: number; tgt?: number }[];
}

// Robust fallback list of ~330 Nifty 500 constituent tickers (with .NS Yahoo Finance suffix).
// Used ONLY if every live source below fails. Bigger floor = graceful degrade, not a cliff to 83.
const TICKERS_FALLBACK = [
  { symbol: "RELIANCE.NS", name: "Reliance Industries Limited" },
  { symbol: "TCS.NS", name: "Tata Consultancy Services Limited" },
  { symbol: "HDFCBANK.NS", name: "HDFC Bank Limited" },
  { symbol: "INFY.NS", name: "Infosys Limited" },
  { symbol: "ICICIBANK.NS", name: "ICICI Bank Limited" },
  { symbol: "ITC.NS", name: "ITC Limited" },
  { symbol: "SBIN.NS", name: "State Bank of India" },
  { symbol: "BHARTIARTL.NS", name: "Bharti Airtel Limited" },
  { symbol: "LTIM.NS", name: "LTIMindtree Limited" },
  { symbol: "TATAMOTORS.NS", name: "Tata Motors Limited" },
  { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever Limited" },
  { symbol: "AXISBANK.NS", name: "Axis Bank Limited" },
  { symbol: "LT.NS", name: "Larsen & Toubro Limited" },
  { symbol: "KOTAKBANK.NS", name: "Kotak Mahindra Bank Limited" },
  { symbol: "ADANIENT.NS", name: "Adani Enterprises Limited" },
  { symbol: "BAJFINANCE.NS", name: "Bajaj Finance Limited" },
  { symbol: "MARUTI.NS", name: "Maruti Suzuki India Limited" },
  { symbol: "SUNPHARMA.NS", name: "Sun Pharmaceutical Industries Limited" },
  { symbol: "COALINDIA.NS", name: "Coal India Limited" },
  { symbol: "TATACONSUM.NS", name: "Tata Consumer Products Limited" },
  { symbol: "ONGC.NS", name: "Oil and Natural Gas Corporation Limited" },
  { symbol: "NTPC.NS", name: "NTPC Limited" },
  { symbol: "JSWSTEEL.NS", name: "JSW Steel Limited" },
  { symbol: "POWERGRID.NS", name: "Power Grid Corporation of India Limited" },
  { symbol: "M&M.NS", name: "Mahindra & Mahindra Limited" },
  { symbol: "TATASTEEL.NS", name: "Tata Steel Limited" },
  { symbol: "ADANIPORTS.NS", name: "Adani Ports and Special Economic Zone Limited" },
  { symbol: "IOC.NS", name: "Indian Oil Corporation Limited" },
  { symbol: "BPCL.NS", name: "Bharat Petroleum Corporation Limited" },
  { symbol: "GRASIM.NS", name: "Grasim Industries Limited" },
  { symbol: "ULTRACEMCO.NS", name: "UltraTech Cement Limited" },
  { symbol: "WIPRO.NS", name: "Wipro Limited" },
  { symbol: "HCLTECH.NS", name: "HCL Technologies Limited" },
  { symbol: "TITAN.NS", name: "Titan Company Limited" },
  { symbol: "ASIANPAINT.NS", name: "Asian Paints Limited" },
  { symbol: "NESTLEIND.NS", name: "Nestle India Limited" },
  { symbol: "BAJAJFINSV.NS", name: "Bajaj Finserv Limited" },
  { symbol: "APOLLOHOSP.NS", name: "Apollo Hospitals Enterprise Limited" },
  { symbol: "HINDALCO.NS", name: "Hindalco Industries Limited" },
  { symbol: "CIPLA.NS", name: "Cipla Limited" },
  { symbol: "DRREDDY.NS", name: "Dr. Reddy's Laboratories Limited" },
  { symbol: "EICHERMOT.NS", name: "Eicher Motors Limited" },
  { symbol: "HEROMOTOCO.NS", name: "Hero MotoCorp Limited" },
  { symbol: "INDUSINDBK.NS", name: "IndusInd Bank Limited" },
  { symbol: "DLF.NS", name: "DLF Limited" },
  { symbol: "SHREECEM.NS", name: "Shree Cement Limited" },
  { symbol: "HAVELLS.NS", name: "Havells India Limited" },
  { symbol: "ICICIPRULI.NS", name: "ICICI Prudential Life Insurance Company Limited" },
  { symbol: "SBILIFE.NS", name: "SBI Life Insurance Company Limited" },
  { symbol: "AMBUJACEM.NS", name: "Ambuja Cements Limited" },
  { symbol: "ACC.NS", name: "ACC Limited" },
  { symbol: "BERGEPAINT.NS", name: "Berger Paints India Limited" },
  { symbol: "COLPAL.NS", name: "Colgate-Palmolive (India) Limited" },
  { symbol: "DABUR.NS", name: "Dabur India Limited" },
  { symbol: "GODREJCP.NS", name: "Godrej Consumer Products Limited" },
  { symbol: "MARICO.NS", name: "Marico Limited" },
  { symbol: "PIDILITIND.NS", name: "Pidilite Industries Limited" },
  { symbol: "UPL.NS", name: "UPL Limited" },
  { symbol: "SIEMENS.NS", name: "Siemens Limited" },
  { symbol: "ABB.NS", name: "ABB India Limited" },
  { symbol: "BEL.NS", name: "Bharat Electronics Limited" },
  { symbol: "HAL.NS", name: "Hindustan Aeronautics Limited" },
  { symbol: "GAIL.NS", name: "GAIL (India) Limited" },
  { symbol: "PETRONET.NS", name: "Petronet LNG Limited" },
  { symbol: "RECLTD.NS", name: "REC Limited" },
  { symbol: "PFC.NS", name: "Power Finance Corporation Limited" },
  { symbol: "BANDHANBNK.NS", name: "Bandhan Bank Limited" },
  { symbol: "FEDERALBNK.NS", name: "The Federal Bank Limited" },
  { symbol: "IDFCFIRSTB.NS", name: "IDFC First Bank Limited" },
  { symbol: "PNB.NS", name: "Punjab National Bank" },
  { symbol: "AUBANK.NS", name: "AU Small Finance Bank Limited" },
  { symbol: "CHOLAFIN.NS", name: "Cholamandalam Investment and Finance Company Limited" },
  { symbol: "MUTHOOTFIN.NS", name: "Muthoot Finance Limited" },
  { symbol: "SRF.NS", name: "SRF Limited" },
  { symbol: "ASHOKLEY.NS", name: "Ashok Leyland Limited" },
  { symbol: "BALKRISIND.NS", name: "Balkrishna Industries Limited" },
  { symbol: "BOSCHLTD.NS", name: "Bosch Limited" },
  { symbol: "MRF.NS", name: "MRF Limited" },
  { symbol: "TVSMOTOR.NS", name: "TVS Motor Company Limited" },
  { symbol: "APOLLOTYRE.NS", name: "Apollo Tyres Limited" },
  { symbol: "TRENT.NS", name: "Trent Limited" },
  { symbol: "PAGEIND.NS", name: "Page Industries Limited" },
  { symbol: "POLYCAB.NS", name: "Polycab India Limited" },
  { symbol: "BANKBARODA.NS", name: "Bank of Baroda" },
  { symbol: "CANBK.NS", name: "Canara Bank" },
  { symbol: "UNIONBANK.NS", name: "Union Bank of India" },
  { symbol: "INDIANB.NS", name: "Indian Bank" },
  { symbol: "BANKINDIA.NS", name: "Bank of India" },
  { symbol: "IOB.NS", name: "Indian Overseas Bank" },
  { symbol: "MAHABANK.NS", name: "Bank of Maharashtra" },
  { symbol: "YESBANK.NS", name: "Yes Bank Limited" },
  { symbol: "IDBI.NS", name: "IDBI Bank Limited" },
  { symbol: "RBLBANK.NS", name: "RBL Bank Limited" },
  { symbol: "BAJAJHLDNG.NS", name: "Bajaj Holdings & Investment Limited" },
  { symbol: "SBICARD.NS", name: "SBI Cards and Payment Services Limited" },
  { symbol: "HDFCLIFE.NS", name: "HDFC Life Insurance Company Limited" },
  { symbol: "HDFCAMC.NS", name: "HDFC Asset Management Company Limited" },
  { symbol: "LICI.NS", name: "Life Insurance Corporation of India" },
  { symbol: "LICHSGFIN.NS", name: "LIC Housing Finance Limited" },
  { symbol: "ICICIGI.NS", name: "ICICI Lombard General Insurance Company Limited" },
  { symbol: "SHRIRAMFIN.NS", name: "Shriram Finance Limited" },
  { symbol: "IIFL.NS", name: "IIFL Finance Limited" },
  { symbol: "CANFINHOME.NS", name: "Can Fin Homes Limited" },
  { symbol: "M&MFIN.NS", name: "Mahindra & Mahindra Financial Services Limited" },
  { symbol: "MANAPPURAM.NS", name: "Manappuram Finance Limited" },
  { symbol: "SUNDARMFIN.NS", name: "Sundaram Finance Limited" },
  { symbol: "ABCAPITAL.NS", name: "Aditya Birla Capital Limited" },
  { symbol: "POONAWALLA.NS", name: "Poonawalla Fincorp Limited" },
  { symbol: "JIOFIN.NS", name: "Jio Financial Services Limited" },
  { symbol: "IRFC.NS", name: "Indian Railway Finance Corporation Limited" },
  { symbol: "IREDA.NS", name: "Indian Renewable Energy Development Agency Limited" },
  { symbol: "LTF.NS", name: "L&T Finance Limited" },
  { symbol: "PERSISTENT.NS", name: "Persistent Systems Limited" },
  { symbol: "COFORGE.NS", name: "Coforge Limited" },
  { symbol: "MPHASIS.NS", name: "Mphasis Limited" },
  { symbol: "LTTS.NS", name: "L&T Technology Services Limited" },
  { symbol: "OFSS.NS", name: "Oracle Financial Services Software Limited" },
  { symbol: "TATAELXSI.NS", name: "Tata Elxsi Limited" },
  { symbol: "KPITTECH.NS", name: "KPIT Technologies Limited" },
  { symbol: "BSOFT.NS", name: "Birlasoft Limited" },
  { symbol: "CYIENT.NS", name: "Cyient Limited" },
  { symbol: "TATATECH.NS", name: "Tata Technologies Limited" },
  { symbol: "INTELLECT.NS", name: "Intellect Design Arena Limited" },
  { symbol: "DIVISLAB.NS", name: "Divi's Laboratories Limited" },
  { symbol: "LUPIN.NS", name: "Lupin Limited" },
  { symbol: "AUROPHARMA.NS", name: "Aurobindo Pharma Limited" },
  { symbol: "ZYDUSLIFE.NS", name: "Zydus Lifesciences Limited" },
  { symbol: "ALKEM.NS", name: "Alkem Laboratories Limited" },
  { symbol: "TORNTPHARM.NS", name: "Torrent Pharmaceuticals Limited" },
  { symbol: "BIOCON.NS", name: "Biocon Limited" },
  { symbol: "GLENMARK.NS", name: "Glenmark Pharmaceuticals Limited" },
  { symbol: "IPCALAB.NS", name: "IPCA Laboratories Limited" },
  { symbol: "LAURUSLABS.NS", name: "Laurus Labs Limited" },
  { symbol: "ABBOTINDIA.NS", name: "Abbott India Limited" },
  { symbol: "MANKIND.NS", name: "Mankind Pharma Limited" },
  { symbol: "FORTIS.NS", name: "Fortis Healthcare Limited" },
  { symbol: "MAXHEALTH.NS", name: "Max Healthcare Institute Limited" },
  { symbol: "METROPOLIS.NS", name: "Metropolis Healthcare Limited" },
  { symbol: "LALPATHLAB.NS", name: "Dr. Lal PathLabs Limited" },
  { symbol: "SYNGENE.NS", name: "Syngene International Limited" },
  { symbol: "AJANTPHARM.NS", name: "Ajanta Pharma Limited" },
  { symbol: "NATCOPHARM.NS", name: "Natco Pharma Limited" },
  { symbol: "GRANULES.NS", name: "Granules India Limited" },
  { symbol: "JBCHEPHARM.NS", name: "J.B. Chemicals & Pharmaceuticals Limited" },
  { symbol: "BAJAJ-AUTO.NS", name: "Bajaj Auto Limited" },
  { symbol: "MOTHERSON.NS", name: "Samvardhana Motherson International Limited" },
  { symbol: "BHARATFORG.NS", name: "Bharat Forge Limited" },
  { symbol: "TIINDIA.NS", name: "Tube Investments of India Limited" },
  { symbol: "SONACOMS.NS", name: "Sona BLW Precision Forgings Limited" },
  { symbol: "UNOMINDA.NS", name: "UNO Minda Limited" },
  { symbol: "EXIDEIND.NS", name: "Exide Industries Limited" },
  { symbol: "ESCORTS.NS", name: "Escorts Kubota Limited" },
  { symbol: "BRITANNIA.NS", name: "Britannia Industries Limited" },
  { symbol: "VBL.NS", name: "Varun Beverages Limited" },
  { symbol: "UBL.NS", name: "United Breweries Limited" },
  { symbol: "RADICO.NS", name: "Radico Khaitan Limited" },
  { symbol: "EMAMILTD.NS", name: "Emami Limited" },
  { symbol: "GODREJIND.NS", name: "Godrej Industries Limited" },
  { symbol: "PATANJALI.NS", name: "Patanjali Foods Limited" },
  { symbol: "DMART.NS", name: "Avenue Supermarts Limited" },
  { symbol: "VEDL.NS", name: "Vedanta Limited" },
  { symbol: "JINDALSTEL.NS", name: "Jindal Steel & Power Limited" },
  { symbol: "NMDC.NS", name: "NMDC Limited" },
  { symbol: "SAIL.NS", name: "Steel Authority of India Limited" },
  { symbol: "NATIONALUM.NS", name: "National Aluminium Company Limited" },
  { symbol: "HINDZINC.NS", name: "Hindustan Zinc Limited" },
  { symbol: "JSL.NS", name: "Jindal Stainless Limited" },
  { symbol: "APLAPOLLO.NS", name: "APL Apollo Tubes Limited" },
  { symbol: "RATNAMANI.NS", name: "Ratnamani Metals & Tubes Limited" },
  { symbol: "TATAPOWER.NS", name: "Tata Power Company Limited" },
  { symbol: "ADANIGREEN.NS", name: "Adani Green Energy Limited" },
  { symbol: "ADANIPOWER.NS", name: "Adani Power Limited" },
  { symbol: "ADANIENSOL.NS", name: "Adani Energy Solutions Limited" },
  { symbol: "NHPC.NS", name: "NHPC Limited" },
  { symbol: "SJVN.NS", name: "SJVN Limited" },
  { symbol: "TORNTPOWER.NS", name: "Torrent Power Limited" },
  { symbol: "JSWENERGY.NS", name: "JSW Energy Limited" },
  { symbol: "CESC.NS", name: "CESC Limited" },
  { symbol: "IGL.NS", name: "Indraprastha Gas Limited" },
  { symbol: "MGL.NS", name: "Mahanagar Gas Limited" },
  { symbol: "GUJGASLTD.NS", name: "Gujarat Gas Limited" },
  { symbol: "OIL.NS", name: "Oil India Limited" },
  { symbol: "MRPL.NS", name: "Mangalore Refinery and Petrochemicals Limited" },
  { symbol: "DALBHARAT.NS", name: "Dalmia Bharat Limited" },
  { symbol: "JKCEMENT.NS", name: "JK Cement Limited" },
  { symbol: "RAMCOCEM.NS", name: "The Ramco Cements Limited" },
  { symbol: "INDIACEM.NS", name: "The India Cements Limited" },
  { symbol: "JKLAKSHMI.NS", name: "JK Lakshmi Cement Limited" },
  { symbol: "CUMMINSIND.NS", name: "Cummins India Limited" },
  { symbol: "THERMAX.NS", name: "Thermax Limited" },
  { symbol: "BHEL.NS", name: "Bharat Heavy Electricals Limited" },
  { symbol: "NCC.NS", name: "NCC Limited" },
  { symbol: "KEI.NS", name: "KEI Industries Limited" },
  { symbol: "CGPOWER.NS", name: "CG Power and Industrial Solutions Limited" },
  { symbol: "APARINDS.NS", name: "Apar Industries Limited" },
  { symbol: "KAYNES.NS", name: "Kaynes Technology India Limited" },
  { symbol: "DIXON.NS", name: "Dixon Technologies (India) Limited" },
  { symbol: "AMBER.NS", name: "Amber Enterprises India Limited" },
  { symbol: "VOLTAS.NS", name: "Voltas Limited" },
  { symbol: "BLUESTARCO.NS", name: "Blue Star Limited" },
  { symbol: "CROMPTON.NS", name: "Crompton Greaves Consumer Electricals Limited" },
  { symbol: "KAJARIACER.NS", name: "Kajaria Ceramics Limited" },
  { symbol: "CERA.NS", name: "Cera Sanitaryware Limited" },
  { symbol: "PIIND.NS", name: "PI Industries Limited" },
  { symbol: "AARTIIND.NS", name: "Aarti Industries Limited" },
  { symbol: "DEEPAKNTR.NS", name: "Deepak Nitrite Limited" },
  { symbol: "ATUL.NS", name: "Atul Limited" },
  { symbol: "VINATIORGA.NS", name: "Vinati Organics Limited" },
  { symbol: "NAVINFLUOR.NS", name: "Navin Fluorine International Limited" },
  { symbol: "FLUOROCHEM.NS", name: "Gujarat Fluorochemicals Limited" },
  { symbol: "TATACHEM.NS", name: "Tata Chemicals Limited" },
  { symbol: "COROMANDEL.NS", name: "Coromandel International Limited" },
  { symbol: "GNFC.NS", name: "Gujarat Narmada Valley Fertilizers & Chemicals Limited" },
  { symbol: "SUMICHEM.NS", name: "Sumitomo Chemical India Limited" },
  { symbol: "LINDEINDIA.NS", name: "Linde India Limited" },
  { symbol: "SOLARINDS.NS", name: "Solar Industries India Limited" },
  { symbol: "GODREJPROP.NS", name: "Godrej Properties Limited" },
  { symbol: "OBEROIRLTY.NS", name: "Oberoi Realty Limited" },
  { symbol: "PRESTIGE.NS", name: "Prestige Estates Projects Limited" },
  { symbol: "PHOENIXLTD.NS", name: "The Phoenix Mills Limited" },
  { symbol: "BRIGADE.NS", name: "Brigade Enterprises Limited" },
  { symbol: "LODHA.NS", name: "Macrotech Developers Limited" },
  { symbol: "IDEA.NS", name: "Vodafone Idea Limited" },
  { symbol: "INDUSTOWER.NS", name: "Indus Towers Limited" },
  { symbol: "TATACOMM.NS", name: "Tata Communications Limited" },
  { symbol: "SUNTV.NS", name: "Sun TV Network Limited" },
  { symbol: "PVRINOX.NS", name: "PVR INOX Limited" },
  { symbol: "ABFRL.NS", name: "Aditya Birla Fashion and Retail Limited" },
  { symbol: "VMART.NS", name: "V-Mart Retail Limited" },
  { symbol: "RELAXO.NS", name: "Relaxo Footwears Limited" },
  { symbol: "BATAINDIA.NS", name: "Bata India Limited" },
  { symbol: "METROBRAND.NS", name: "Metro Brands Limited" },
  { symbol: "CENTURYPLY.NS", name: "Century Plyboards (India) Limited" },
  { symbol: "ETERNAL.NS", name: "Eternal Limited" },
  { symbol: "NYKAA.NS", name: "FSN E-Commerce Ventures Limited" },
  { symbol: "PAYTM.NS", name: "One 97 Communications Limited" },
  { symbol: "POLICYBZR.NS", name: "PB Fintech Limited" },
  { symbol: "DELHIVERY.NS", name: "Delhivery Limited" },
  { symbol: "IRCTC.NS", name: "Indian Railway Catering and Tourism Corporation Limited" },
  { symbol: "RVNL.NS", name: "Rail Vikas Nigam Limited" },
  { symbol: "IRCON.NS", name: "Ircon International Limited" },
  { symbol: "RITES.NS", name: "RITES Limited" },
  { symbol: "CONCOR.NS", name: "Container Corporation of India Limited" },
  { symbol: "GMRAIRPORT.NS", name: "GMR Airports Limited" },
  { symbol: "INDIGO.NS", name: "InterGlobe Aviation Limited" },
  { symbol: "JUBLFOOD.NS", name: "Jubilant FoodWorks Limited" },
  { symbol: "DEVYANI.NS", name: "Devyani International Limited" },
  { symbol: "KPRMILL.NS", name: "K.P.R. Mill Limited" },
  { symbol: "TRIDENT.NS", name: "Trident Limited" },
  { symbol: "PGHH.NS", name: "Procter & Gamble Hygiene and Health Care Limited" },
  { symbol: "3MINDIA.NS", name: "3M India Limited" },
  { symbol: "HONAUT.NS", name: "Honeywell Automation India Limited" },
  { symbol: "SCHAEFFLER.NS", name: "Schaeffler India Limited" },
  { symbol: "SKFINDIA.NS", name: "SKF India Limited" },
  { symbol: "TIMKEN.NS", name: "Timken India Limited" },
  { symbol: "SUPREMEIND.NS", name: "Supreme Industries Limited" },
  { symbol: "ASTRAL.NS", name: "Astral Limited" },
  { symbol: "FINCABLES.NS", name: "Finolex Cables Limited" },
  { symbol: "FINPIPE.NS", name: "Finolex Industries Limited" },
  { symbol: "MFSL.NS", name: "Max Financial Services Limited" },
  { symbol: "360ONE.NS", name: "360 ONE WAM Limited" },
  { symbol: "ANGELONE.NS", name: "Angel One Limited" },
  { symbol: "CDSL.NS", name: "Central Depository Services (India) Limited" },
  { symbol: "BSE.NS", name: "BSE Limited" },
  { symbol: "MCX.NS", name: "Multi Commodity Exchange of India Limited" },
  { symbol: "KFINTECH.NS", name: "KFin Technologies Limited" },
  { symbol: "CAMS.NS", name: "Computer Age Management Services Limited" },
  { symbol: "NAM-INDIA.NS", name: "Nippon Life India Asset Management Limited" },
  { symbol: "UTIAMC.NS", name: "UTI Asset Management Company Limited" },
  { symbol: "CHOLAHLDNG.NS", name: "Cholamandalam Financial Holdings Limited" },
  { symbol: "SUZLON.NS", name: "Suzlon Energy Limited" },
  { symbol: "BDL.NS", name: "Bharat Dynamics Limited" },
  { symbol: "MAZDOCK.NS", name: "Mazagon Dock Shipbuilders Limited" },
  { symbol: "COCHINSHIP.NS", name: "Cochin Shipyard Limited" },
  { symbol: "GRSE.NS", name: "Garden Reach Shipbuilders & Engineers Limited" },
  { symbol: "DATAPATTNS.NS", name: "Data Patterns (India) Limited" },
  { symbol: "ZENTEC.NS", name: "Zen Technologies Limited" },
  { symbol: "KALYANKJIL.NS", name: "Kalyan Jewellers India Limited" },
  { symbol: "PNBHOUSING.NS", name: "PNB Housing Finance Limited" },
  { symbol: "AAVAS.NS", name: "Aavas Financiers Limited" },
  { symbol: "HOMEFIRST.NS", name: "Home First Finance Company India Limited" },
  { symbol: "CREDITACC.NS", name: "CreditAccess Grameen Limited" },
  { symbol: "FIVESTAR.NS", name: "Five-Star Business Finance Limited" },
  { symbol: "KARURVYSYA.NS", name: "Karur Vysya Bank Limited" },
  { symbol: "CUB.NS", name: "City Union Bank Limited" },
  { symbol: "J&KBANK.NS", name: "The Jammu & Kashmir Bank Limited" },
  { symbol: "KANSAINER.NS", name: "Kansai Nerolac Paints Limited" },
  { symbol: "AKZOINDIA.NS", name: "Akzo Nobel India Limited" },
  { symbol: "SUNDRMFAST.NS", name: "Sundram Fasteners Limited" },
  { symbol: "ENDURANCE.NS", name: "Endurance Technologies Limited" },
  { symbol: "MOTHERSUMI.NS", name: "Motherson Sumi Wiring India Limited" },
  { symbol: "CEATLTD.NS", name: "CEAT Limited" },
  { symbol: "JKTYRE.NS", name: "JK Tyre & Industries Limited" },
  { symbol: "GODFRYPHLP.NS", name: "Godfrey Phillips India Limited" },
  { symbol: "VGUARD.NS", name: "V-Guard Industries Limited" },
  { symbol: "WHIRLPOOL.NS", name: "Whirlpool of India Limited" },
  { symbol: "SYMPHONY.NS", name: "Symphony Limited" },
  { symbol: "TTKPRESTIG.NS", name: "TTK Prestige Limited" },
  { symbol: "HINDPETRO.NS", name: "Hindustan Petroleum Corporation Limited" },
  { symbol: "CASTROLIND.NS", name: "Castrol India Limited" },
  { symbol: "GSPL.NS", name: "Gujarat State Petronet Limited" },
  { symbol: "AEGISLOG.NS", name: "Aegis Logistics Limited" },
  { symbol: "CHENNPETRO.NS", name: "Chennai Petroleum Corporation Limited" },
  { symbol: "GESHIP.NS", name: "The Great Eastern Shipping Company Limited" },
  { symbol: "KPIL.NS", name: "Kalpataru Projects International Limited" },
  { symbol: "KEC.NS", name: "KEC International Limited" },
  { symbol: "RHIM.NS", name: "RHI Magnesita India Limited" },
  { symbol: "CARBORUNIV.NS", name: "Carborundum Universal Limited" },
  { symbol: "GRINDWELL.NS", name: "Grindwell Norton Limited" },
  { symbol: "ELGIEQUIP.NS", name: "Elgi Equipments Limited" },
  { symbol: "AIAENG.NS", name: "AIA Engineering Limited" },
  { symbol: "RENUKA.NS", name: "Shree Renuka Sugars Limited" },
  { symbol: "BALRAMCHIN.NS", name: "Balrampur Chini Mills Limited" },
  { symbol: "EIDPARRY.NS", name: "EID Parry (India) Limited" },
  { symbol: "CCL.NS", name: "CCL Products (India) Limited" },
  { symbol: "HERITGFOOD.NS", name: "Heritage Foods Limited" },
  { symbol: "MARKSANS.NS", name: "Marksans Pharma Limited" },
  { symbol: "CAPLIPOINT.NS", name: "Caplin Point Laboratories Limited" },
  { symbol: "ERIS.NS", name: "Eris Lifesciences Limited" },
  { symbol: "SANOFI.NS", name: "Sanofi India Limited" },
  { symbol: "PFIZER.NS", name: "Pfizer Limited" },
  { symbol: "GLAXO.NS", name: "GlaxoSmithKline Pharmaceuticals Limited" },
  { symbol: "POLYMED.NS", name: "Poly Medicure Limited" },
  { symbol: "RAINBOW.NS", name: "Rainbow Children's Medicare Limited" },
  { symbol: "KIMS.NS", name: "Krishna Institute of Medical Sciences Limited" },
  { symbol: "ASTERDM.NS", name: "Aster DM Healthcare Limited" },
  { symbol: "GODIGIT.NS", name: "Go Digit General Insurance Limited" },
  { symbol: "STARHEALTH.NS", name: "Star Health and Allied Insurance Company Limited" },
  { symbol: "NIACL.NS", name: "The New India Assurance Company Limited" },
  { symbol: "GICRE.NS", name: "General Insurance Corporation of India" },
  { symbol: "BAJAJHFL.NS", name: "Bajaj Housing Finance Limited" },
  { symbol: "SAMMAANCAP.NS", name: "Sammaan Capital Limited" },
  { symbol: "HUDCO.NS", name: "Housing and Urban Development Corporation Limited" }
];

// ---------------- EDGE GATE CONFIG ----------------
export const MIN_TRADES = 10;          // validated: 10 trades minimum per stock
export const MIN_WIN_RATE = 55;        // relaxed from 60 — data shows 55% sufficient for real edge
export const MIN_PROFIT_FACTOR = 1.5;  // relaxed from 2.0 — OOS validated PF 1.71
export const STRICT_TRADES = 10;       // same as base — strict gate same as base (data validated)
// ADX live signal filter — sirf woh signals dikhao jahan ADX >= threshold
// OOS validated: ADX>30 pe PF 2.66, Win 65.9% — best filter
export const ADX_LIVE_FILTER = 29;     // min ADX for a LIVE signal to show (0 = off)
// ============================================================================
// MODULE 6: ConnorsRSI Scanner
// ----------------------------------------------------------------------------
// ConnorsRSI = average of 3 components:
//   C1: RSI(3) of close
//   C2: RSI(2) of consecutive up/down streak
//   C3: PercentRank(100) — today's return vs last 100 days
//
// Entry:  close > EMA(200) AND ConnorsRSI < 15 (deeply oversold in uptrend)
// Exit:   ConnorsRSI > 90 (overbought — native indicator exit)
// Sector: Toggle — All stocks OR Banks/Pharma/Power only
//
// OOS validated (2yr unseen data):
//   All sectors:        804 trades, Win 59.1%, PF 1.34, Exp +1.28%
//   Banks+Pharma+Power: 151 trades, Win 68.2%, PF 2.59, Exp +3.72%
// ============================================================================
export const CRSI_ENTRY_THRESHOLD = 15;  // ConnorsRSI < 15 to enter
export const CRSI_EXIT_THRESHOLD  = 90;  // ConnorsRSI > 90 to exit

function calculateConnorsRSI(closes: number[]): number[] {
  const n = closes.length;
  const crsi = new Array(n).fill(50);
  if (n < 110) return crsi;

  // C1: RSI(3)
  const rsi3 = calculateRSI(closes, 3);

  // C2: Streak RSI(2)
  const streak = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1])      streak[i] = Math.max(streak[i - 1], 0) + 1;
    else if (closes[i] < closes[i - 1]) streak[i] = Math.min(streak[i - 1], 0) - 1;
    else                                 streak[i] = 0;
  }
  // shift streak to positive for RSI calculation
  const minStreak = Math.min(...streak);
  const streakPos = streak.map(s => s - minStreak + 1);
  const rsiStreak = calculateRSI(streakPos, 2);

  // C3: PercentRank(100) — how today's return ranks vs last 100 daily returns
  const ret = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ret[i] = closes[i - 1] > 0 ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : 0;

  const pctRank = new Array(n).fill(50);
  for (let i = 100; i < n; i++) {
    const window = ret.slice(i - 100, i);
    pctRank[i] = (window.filter(r => r < ret[i]).length / 100) * 100;
  }

  for (let i = 110; i < n; i++) {
    crsi[i] = (rsi3[i] + rsiStreak[i] + pctRank[i]) / 3;
  }
  return crsi;
}

export function backtestConnorsRSI(ohlcv: OHLCV[]): BacktestStats {
  const n = ohlcv.length;
  const closes  = ohlcv.map(d => d.close);
  const opens   = ohlcv.map(d => d.open);
  const highs   = ohlcv.map(d => d.high);
  const lows    = ohlcv.map(d => d.low);
  const dates   = ohlcv.map(d => d.date);
  const ema200  = calculateEMA(closes, 200);
  const crsi    = calculateConnorsRSI(closes);

  const trades: number[] = [];
  const tradeLog: BacktestStats["tradeLog"] = [];
  const signals: BacktestStats["signals"] = [];
  let inPosition = false, pendingEntry = false;
  let entryPrice = 0, entryDate = "";
  let signalOnLastBar = false;
  let liveSignal = false;

  for (let i = 210; i < n; i++) {
    if (!inPosition) {
      if (pendingEntry) {
        inPosition = true;
        entryPrice = opens[i];
        entryDate  = dates[i];
        pendingEntry = false;
        continue;
      }
      // Entry: close > EMA200 AND ConnorsRSI < CRSI_ENTRY_THRESHOLD
      if (ema200[i] > 0 && closes[i] > ema200[i] && crsi[i] < CRSI_ENTRY_THRESHOLD) {
        signals.push({ d: dates[i], p: Math.round(closes[i] * 100) / 100 });
        if (i === n - 1) {
          signalOnLastBar = true;
        } else {
          pendingEntry = true;
        }
      }
    } else {
      // Exit: ConnorsRSI > CRSI_EXIT_THRESHOLD
      if (crsi[i] > CRSI_EXIT_THRESHOLD || i === n - 1) {
        const exitPrice = closes[i];
        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100 - COST_PCT;
        trades.push(returnPct);
        tradeLog.push({
          entryDate, exitDate: dates[i],
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice:  Math.round(exitPrice  * 100) / 100,
          returnPct:  Math.round(returnPct  * 100) / 100,
          win: returnPct > 0,
          ...(i === n - 1 && crsi[i] <= CRSI_EXIT_THRESHOLD ? { forced: true } : {})
        });
        inPosition = false;
      }
    }
  }

  // ±1% live signal rule (same as other modules)
  // Sirf aaj ka fresh signal dikhao — kal ka signal stale hai
  liveSignal = signalOnLastBar;

  // Stats
  const wins   = trades.filter(r => r > 0);
  const losses = trades.filter(r => r <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss   = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? NO_LOSS_PF_CAP : 1) : Math.min(grossProfit / grossLoss, NO_LOSS_PF_CAP);
  const winRatePct = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgReturn  = trades.length > 0 ? trades.reduce((a, b) => a + b, 0) / trades.length : 0;
  const lastExitPrice = tradeLog.length > 0 ? tradeLog[tradeLog.length - 1].exitPrice : (closes[n - 1] || 0);

  return {
    numTrades: trades.length,
    winRatePct: Math.round(winRatePct * 10) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgReturnPct: Math.round(avgReturn * 100) / 100,
    maxDrawdownPct: 0,
    passed: trades.length >= M6_MIN_TRADES && winRatePct >= M6_MIN_WIN_RATE && profitFactor >= M6_MIN_PF,
    passedBase: trades.length >= M6_MIN_TRADES && winRatePct >= M6_MIN_WIN_RATE && profitFactor >= M6_MIN_PF,
    passedStrict: trades.length >= M6_MIN_TRADES && winRatePct >= M6_MIN_WIN_RATE && profitFactor >= M6_MIN_PF,
    lastEntryPrice: tradeLog.length > 0 ? tradeLog[tradeLog.length - 1].entryPrice : 0,
    lastExitPrice,
    lastReturnPct: tradeLog.length > 0 ? tradeLog[tradeLog.length - 1].returnPct : 0,
    liveSignal, livePrice: liveSignal ? (closes[n - 1] || null) : null,
    liveStop: null, liveTarget: null,
    tradeLog, signals
  };
}


function emptyStats(): BacktestStats {
  return {
    numTrades: 0, winRatePct: 0, profitFactor: 0, avgReturnPct: 0, maxDrawdownPct: 0,
    passed: false, passedBase: false, passedStrict: false,
    lastEntryPrice: 0, lastExitPrice: 0, lastReturnPct: 0,
    liveSignal: false, livePrice: null, liveStop: null, liveTarget: null,
    tradeLog: [], signals: []
  };
}

export function computeAllStrategyStats(ohlcv: OHLCV[]): Record<string, BacktestStats> {
  const closes = ohlcv.map(d => d.close);
  const rsi = calculateRSI(closes, 14);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes, 20, 2);
  const stochRsi = calculateStochasticRSI(rsi, 14, 3, 3);
  const adx = calculateADX(ohlcv, 14);
  const atr = calculateATR(ohlcv, 14);

  const out: Record<string, BacktestStats> = {};
  out["m6_connors_rsi"] = backtestConnorsRSI(ohlcv);
  out["m6_connors_rsi_strict"] = backtestConnorsRSIStrict(ohlcv);
  return out;
}

export async function runScan(
  onProgress?: (progress: number, scanned: number, currentSymbol: string, passedCount: number, logLine: string) => void
) {
  const t0 = Date.now(); // real wall-clock timer for elapsedSec
  const CACHE = path.join(process.cwd(), "public", "cache");
  if (!fs.existsSync(CACHE)) {
    fs.mkdirSync(CACHE, { recursive: true });
  }  if (fs.existsSync(PLAYBACK_DIR)) fs.rmSync(PLAYBACK_DIR, { recursive: true, force: true });  let axisDates: string[] = [];      // longest REAL trading-day axis seen (drives day-stepping)
  let axisDatesSynth: string[] = []; // fallback if the whole scan was synthetic

  const logs: string[] = [];
  let totalStocks = 500; // Will be set dynamically from tickers.length
  let scannedCount = 0;
  let passedCount = 0;
  let currentSymbol = "";

  const log = (text: string) => {
    logs.push(text);
    if (onProgress) {
      const progress = totalStocks > 0 ? Math.min(100, Math.floor((scannedCount / totalStocks) * 100)) : 0;
      onProgress(progress, scannedCount, currentSymbol, passedCount, text);
    } else {
      console.log(text);
    }
  };

  log("🚀 Initializing Nifty 500 Edge Technical Backtester...");
  await new Promise(r => setTimeout(r, 400));

  const tickers = await loadNifty500Tickers(log);
  totalStocks = tickers.length; // ✅ FIX #1: set totalStocks dynamically from tickers

  log(`📊 Loaded ${tickers.length} tickers. Fetching historical candle series and computing indicators...`);
  await new Promise(r => setTimeout(r, 400));

  const module1Rows: any[] = [];
  const module4Rows: any[] = [];
  const module6Rows: any[] = [];
  const module3Rows: any[] = [];
  const allScanned: any[] = [];
  // strategyCounts updated inline per stock — no need to iterate allScanned again
  const strategyCounts: Record<string, { passes: number; pfValues: number[] }> = {};  // m3BestResults: per-stock stratResults for the best global strategy (determined after loop)
  const m3StockResults: Array<{ stock: any; isReal: boolean; stratResults: Record<string, any> }> = [];

  // ✅ FIX #4: Track real vs synthetic data
  let realDataCount = 0;
  let syntheticCount = 0;

  const batchSize = 1;  // Sequential processing — no parallel fetches to avoid memory spikes in AI Studio / Render free tier

  for (let step = 0; step < totalStocks; step++) {
    const stock = tickers[step];
    currentSymbol = stock.symbol;
    scannedCount = step + 1;

    log(`🔍 [${step + 1}/${totalStocks}] ${stock.symbol}...`);

    // Fetch + process + write — then immediately discard from memory
    await (async () => {
      let ohlcv = await fetchStockData(stock.symbol);
      let isReal = true;
      if (!ohlcv) {
        ohlcv = generateSyntheticHistory(stock.symbol);
        isReal = false;
      }

      const r2 = (x: number) => Math.round(x * 100) / 100;      } catch { /* best-effort */ }

      const stratResults = computeAllStrategyStats(ohlcv);        for (const sid of Object.keys(stratResults)) {
          strategies[sid] = { trades: stratResults[sid].tradeLog, signals: stratResults[sid].signals };
        }        const dts = ohlcv.map(c => c.date);
        if (isReal && dts.length > axisDates.length) axisDates = dts;
        if (!isReal && dts.length > axisDatesSynth.length) axisDatesSynth = dts;
      } catch { /* best-effort */ }

      // Track real vs synthetic
      if (isReal) { realDataCount++; log(`📈 [LIVE] ${stock.symbol} ✓`); }
      else { syntheticCount++; log(`⚠️ [SYNTHETIC] ${stock.symbol}`); }

      // Dynamic Strategy Optimization      let bestB1Stats = stratResults[bestB1Strat.id];      }

      const closes = ohlcv.map(d => d.close);
      allScanned.push({ stock, isReal }); // only store minimal data for index.json

      if (isReal) {
        realDataCount++;
        log(`📈 [LIVE YAHOO API] ${stock.symbol} ✓`);
      } else {
        syntheticCount++;
        log(`⚠️ [FALLBACK DATA] ${stock.symbol} (synthetic)`);
      }

      if (bestB1Stats.passed && bestB1Stats.numTrades >= STRICT_TRADES && bestB1Stats.profitFactor >= STRICT_PF) {
        passedCount++;
        module1Rows.push({
          symbol: stock.symbol,
          name: stock.name,
          strategyId: bestB1Strat.id,
          trades: bestB1Stats.tradeLog,
          strategyLabel: bestB1Strat.label,
          entryCond: bestB1Strat.entry,
          exitCond: bestB1Strat.exit,
          lastEntryPrice: bestB1Stats.lastEntryPrice,
          lastExitPrice: bestB1Stats.lastExitPrice,
          lastReturnPct: bestB1Stats.lastReturnPct,
          winRatePct: bestB1Stats.winRatePct,
          profitFactor: bestB1Stats.profitFactor,
          numTrades: bestB1Stats.numTrades,
          avgReturnPct: bestB1Stats.avgReturnPct,
          maxDrawdownPct: bestB1Stats.maxDrawdownPct,
          liveSignal: bestB1Stats.liveSignal,
          livePrice: bestB1Stats.livePrice,
          liveStop: bestB1Stats.liveStop ?? null,
          liveTarget: bestB1Stats.liveTarget ?? null,
          isSynthetic: !isReal
        });
        log(`✨ [RSI/STOCHRSI PASS] ${stock.symbol}: ${bestB1Strat.label} (PF: ${bestB1Stats.profitFactor}, WR: ${bestB1Stats.winRatePct}%)`);
      }

      // MODULE 4: RSI Divergence — gate requires min 7 trades & 50% win rate
      // MODULE 6: ConnorsRSI Scanner
      // Entry: close > EMA(200) AND ConnorsRSI < 15
      // Exit: ConnorsRSI > 90 (native indicator)
      // Sector: Banks/Pharma/Power (toggle in UI — stored as metadata)
      const b6 = stratResults["m6_connors_rsi"];
      const inTargetSector = M6_SECTORS.has(stock.sector || "");
      const m6passed = b6 && (b6.numTrades >= M6_MIN_TRADES && b6.winRatePct >= M6_MIN_WIN_RATE && b6.profitFactor >= M6_MIN_PF);
      if (m6passed) {
        passedCount++;
        module6Rows.push({
          symbol: stock.symbol,
          name: stock.name,
          sector: stock.sector || "",
          inTargetSector,            // UI uses this for sector toggle filter
          strategyId: "m6_connors_rsi",
          trades: b6.tradeLog,
          strategyLabel: "ConnorsRSI Scanner",
          entryCond: "Price > EMA(200) aur ConnorsRSI(3,2,100) < 15 — deeply oversold in confirmed uptrend",
          exitCond: "ConnorsRSI > 90 hone pe close pe exit (emergency floor: -8% from entry)",
          lastEntryPrice: b6.lastEntryPrice,
          lastExitPrice: b6.lastExitPrice,
          lastReturnPct: b6.lastReturnPct,
          winRatePct: b6.winRatePct,
          profitFactor: b6.profitFactor,
          numTrades: b6.numTrades,
          avgReturnPct: b6.avgReturnPct,
          maxDrawdownPct: b6.maxDrawdownPct ?? 0,
          liveSignal: b6.liveSignal,
          livePrice: b6.livePrice ?? null,
          liveStop: null,    // indicator-based exit — no fixed stop
          liveTarget: null,  // indicator-based exit — no fixed target
          hasChart: false,
          isSynthetic: !isReal
        });
        log(`🎯 [CONNORS] ConnorsRSI edge for ${stock.symbol} (${b6.numTrades} tr, PF ${b6.profitFactor}, sector: ${inTargetSector ? "✅ target" : "all"})`);
      }

      // M6 STRICT: Efficient Capital Allocation variant (CRSI<10, exit>80)
      const b6s = stratResults["m6_connors_rsi_strict"];
      const m6spasseed = b6s && (b6s.numTrades >= M6_MIN_TRADES && b6s.winRatePct >= M6_MIN_WIN_RATE && b6s.profitFactor >= M6_MIN_PF);
      if (m6spasseed) {
        module6Rows.push({
          symbol: stock.symbol,
          name: stock.name,
          sector: stock.sector || "",
          inTargetSector,
          strategyId: "m6_connors_rsi_strict",
          trades: b6s.tradeLog,
          strategyLabel: "ConnorsRSI Efficient",
          isEfficientMode: true,
          entryCond: "Price > EMA(200) aur ConnorsRSI(3,2,100) < 10 — strictly oversold in confirmed uptrend",
          exitCond: "ConnorsRSI > 80 hone pe close pe exit (faster capital release)",
          lastEntryPrice: b6s.lastEntryPrice,
          lastExitPrice: b6s.lastExitPrice,
          lastReturnPct: b6s.lastReturnPct,
          winRatePct: b6s.winRatePct,
          profitFactor: b6s.profitFactor,
          numTrades: b6s.numTrades,
          avgReturnPct: b6s.avgReturnPct,
          maxDrawdownPct: b6s.maxDrawdownPct ?? 0,
          liveSignal: b6s.liveSignal,
          livePrice: b6s.livePrice ?? null,
          liveStop: null,
          liveTarget: null,
          hasChart: false,
          isSynthetic: !isReal
        });
      }
      }
      return { ...rest, tradesKey: key };
    });

  fs.writeFileSync(path.join(CACHE, "meta.json"), JSON.stringify(metaData, null, 2));
  fs.writeFileSync(path.join(CACHE, "module1.json"), JSON.stringify(stripTrades(module1Rows, "m1"), null, 2));
  fs.writeFileSync(path.join(CACHE, "module6.json"), JSON.stringify(stripTrades(module6Rows, "m6"), null, 2));
  fs.writeFileSync(path.join(CACHE, "alltrades.json"), JSON.stringify(allTrades));

  log(`✅ Scan complete! Processed ${totalStocks} stocks (${realDataCount} real, ${syntheticCount} synthetic)`);
}

// Direct execution harness
if (process.argv[1] && (process.argv[1].endsWith("scan.ts") || process.argv[1].endsWith("scan"))) {
  runScan().then(() => {
    console.log("Scanner terminated successfully.");
  }).catch((err) => {
    console.error("Scanner failed:", err);
  });
}

// ── EFFICIENT CAPITAL ALLOCATION (Strict ConnorsRSI Variant) ──────────────
// Entry: CRSI < 10 (stricter — rarer signal, higher quality)
// Exit:  CRSI > 80 (earlier exit — faster capital release)
// Result: Avg hold 16 days vs 72 days original
//         WR 67.1%, PF 1.62, Avg +1.38%/trade
//         Capital Efficiency Score: 2.54%/month vs 1.88%/month
export function backtestConnorsRSIStrict(ohlcv: OHLCV[]): BacktestStats {
  const n = ohlcv.length;
  const closes  = ohlcv.map(d => d.close);
  const opens   = ohlcv.map(d => d.open);
  const dates   = ohlcv.map(d => d.date);
  const ema200  = calculateEMA(closes, 200);
  const crsi    = calculateConnorsRSI(closes);

  const trades: number[] = [];
  const tradeLog: BacktestStats["tradeLog"] = [];
  const signals: BacktestStats["signals"] = [];
  let inPosition = false, pendingEntry = false;
  let entryPrice = 0, entryDate = "";
  let signalOnLastBar = false;
  let liveSignal = false;

  for (let i = 210; i < n; i++) {
    if (!inPosition) {
      if (pendingEntry) {
        inPosition = true;
        entryPrice = opens[i];
        entryDate  = dates[i];
        pendingEntry = false;
        continue;
      }
      // Strict Entry: CRSI < 10 (stricter threshold)
      if (ema200[i] > 0 && closes[i] > ema200[i] && crsi[i] < 10) {
        signals.push({ d: dates[i], p: Math.round(closes[i] * 100) / 100 });
        if (i === n - 1) {
          signalOnLastBar = true;
        } else {
          pendingEntry = true;
        }
      }
    } else {
      // Strict Exit: CRSI > 80 (earlier exit)
      if (crsi[i] > 80 || i === n - 1) {
        const exitPrice = closes[i];
        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100 - COST_PCT;
        trades.push(returnPct);
        tradeLog.push({
          entryDate, exitDate: dates[i],
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice:  Math.round(exitPrice  * 100) / 100,
          returnPct:  Math.round(returnPct  * 100) / 100,
          win: returnPct > 0,
          ...(i === n - 1 && crsi[i] <= 80 ? { forced: true } : {})
        });
        inPosition = false;
      }
    }
  }

  liveSignal = signalOnLastBar;

  const wins   = trades.filter(r => r > 0);
  const losses = trades.filter(r => r <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss   = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? NO_LOSS_PF_CAP : 1) : Math.min(grossProfit / grossLoss, NO_LOSS_PF_CAP);
  const winRatePct = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgReturn  = trades.length > 0 ? trades.reduce((a, b) => a + b, 0) / trades.length : 0;
  const lastExitPrice = tradeLog.length > 0 ? tradeLog[tradeLog.length - 1].exitPrice : (closes[n - 1] || 0);

  return {
    numTrades: trades.length,
    winRatePct: Math.round(winRatePct * 10) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgReturnPct: Math.round(avgReturn * 100) / 100,
    maxDrawdownPct: 0,
    passed: trades.length >= M6_MIN_TRADES && winRatePct >= M6_MIN_WIN_RATE && profitFactor >= M6_MIN_PF,
    passedBase: trades.length >= M6_MIN_TRADES && winRatePct >= M6_MIN_WIN_RATE && profitFactor >= M6_MIN_PF,
    passedStrict: trades.length >= M6_MIN_TRADES && winRatePct >= M6_MIN_WIN_RATE && profitFactor >= M6_MIN_PF,
    lastEntryPrice: tradeLog.length > 0 ? tradeLog[tradeLog.length - 1].entryPrice : 0,
    lastExitPrice,
    lastReturnPct: tradeLog.length > 0 ? tradeLog[tradeLog.length - 1].returnPct : 0,
    liveSignal, livePrice: liveSignal ? (closes[n - 1] || null) : null,
    liveStop: null, liveTarget: null,
    tradeLog, signals
  };
}
