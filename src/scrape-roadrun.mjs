// src/scrape-roadrun.mjs
import axios from "axios";
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import fs from "fs";
import path from "path";
import iconv from "iconv-lite";
import { upsertRaceToNotion } from "./notion.mjs";

const BASE_URL = "http://www.roadrun.co.kr/schedule";
const YEARS = [2026]; // 필요 연도

// 유틸: 공백 정리
function clean(text) {
  return text.replace(/\s+/g, " ").trim();
}

// 유틸: 한국식 날짜 "2026년1월1일" → dayjs 객체
function parseKoreanDate(str) {
  const m = str.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return dayjs(`${y}-${mo}-${d}`);
}

// 유틸: "출발시간:09:00" 같은 텍스트에서 HH:MM
// 유틸: "09:00" 또는 "출발시간:오전 9시" / "오후 3시30분" 등에서 HH:MM 추출
function parseTime(str) {
  const s = str.replace(/\s+/g, ""); // 공백 제거해서 패턴 단순화

  // 1) 기본 HH:MM 먼저 체크 (예: "09:00")
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    const [, h, mi] = m;
    return `${h.padStart(2, "0")}:${mi}`;
  }

  // 2) "오전/오후 9시" 또는 "오후 3시30분" 형태
  // 예: "출발시간:오전9시", "오후3시30분", "오전09시00분"
  m = s.match(/(오전|오후)(\d{1,2})시(?:(\d{1,2})분)?/);
  if (m) {
    const [, ampm, hourStr, minuteStr] = m;
    let hour = parseInt(hourStr, 10);
    let minute = minuteStr ? parseInt(minuteStr, 10) : 0;

    if (ampm === "오후" && hour < 12) {
      hour += 12;
    }
    if (ampm === "오전" && hour === 12) {
      // "오전 12시"는 00시로
      hour = 0;
    }

    const h = String(hour).padStart(2, "0");
    const mi = String(minute).padStart(2, "0");
    return `${h}:${mi}`;
  }

  // 3) 숫자 + "시"만 있는 경우 (예: "9시")
  m = s.match(/(\d{1,2})시/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const h = String(hour).padStart(2, "0");
    return `${h}:00`;
  }

  // 못 찾으면 null
  return null;
}

// 유틸: 종목 정규화
function normalizeCourse(text) {
  return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s.includes("풀")) return "full";
        if (s.includes("하프")) return "half";
        const m = s.match(/(\d+)\s*k/i);
        if (m) return `${m[1]}k`;
        return s;
      });
}

// HTTP GET (EUC-KR → UTF-8 디코딩 가정, 추측)
async function fetchHtml(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer"
  });
  // 인코딩이 EUC-KR이라고 가정 (추측)
  const decoded = iconv.decode(res.data, "euc-kr");
  return decoded;
}

// list.php에서 view.php?no=XXX 목록 추출
async function fetchListNos(years) {
  const nos = new Set();

  for (const year of years) {
    const url = `${BASE_URL}/list.php?syear_key=${year}`;
    console.log(`[LIST] ${url}`);
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    $("a[href*='view.php?no=']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/view\.php\?no=(\d+)/);
      if (m) {
        nos.add(m[1]);
      }
    });
  }

  console.log(`[LIST] Found ${nos.size} events`);
  return Array.from(nos);
}

// view.php 상세 페이지에서 필요한 6개 필드 추출
async function fetchRaceDetail(no) {
  const url = `${BASE_URL}/view.php?no=${no}`;
  console.log(`[DETAIL] ${url}`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const trs = $("table tbody tr").toArray();
  if (trs.length === 0) {
    throw new Error("No TR rows found in detail page");
  }

  // 결과 담을 객체 (초기값)
  let raceName = "";
  let dateRaw = "";
  let courseRaw = "";
  let region = "";
  let venue = "";
  let entryRaw = "";
  let homepage = null;

  // 각 tr마다: 첫 번째 td = 라벨, 마지막 td = 값
  for (const tr of trs) {
    const tds = $(tr).find("td").toArray();
    if (tds.length < 2) continue;

    const label = clean($(tds[0]).text());      // "대회명", "대회일시" ...
    const valueTd = $(tds[tds.length - 1]);     // 값이 들어있는 마지막 td
    const valueText = clean(valueTd.text());

    if (!label) continue;

    if (label.includes("대회명")) {
      raceName = valueText;
    } else if (label.includes("대회일시")) {
      dateRaw = valueText;
    } else if (label.includes("대회종목")) {
      courseRaw = valueText;
    } else if (label.includes("대회지역")) {
      region = valueText;
    } else if (label.includes("대회장소")) {
      venue = valueText;
    } else if (label.includes("접수기간")) {
      entryRaw = valueText;
    } else if (label.includes("홈페이지")) {
      const a = valueTd.find("a").first();
      if (a.length && a.attr("href")) {
        homepage = a.attr("href");
      } else {
        const m = valueText.match(/https?:\/\/\S+/);
        if (m) homepage = m[0];
      }
    }
  }

  // 1) 대회일시 → YYYY-MM-DD HH:MM
  let raceDatetime = null;
  if (dateRaw) {
    const dateObj = parseKoreanDate(dateRaw);
    const timeStr = parseTime(dateRaw) || "00:00";
    if (dateObj) {
      raceDatetime = `${dateObj.format("YYYY-MM-DD")} ${timeStr}`;
    }
  }

  // 2) 대회종목 정규화
  const course = normalizeCourse(courseRaw);

  // 3) 지역 + 장소
  const locationFull = [region, venue].filter(Boolean).join(" ");

  // 4) 접수기간 → 시작/마감 분리
  let entryStart = null;
  let entryEnd = null;
  if (entryRaw && entryRaw.includes("~")) {
    const [sRaw, eRaw] = entryRaw.split("~").map(clean);
    const s = parseKoreanDate(sRaw);
    const e = parseKoreanDate(eRaw);
    if (s) entryStart = s.format("YYYY-MM-DD");
    if (e) entryEnd = e.format("YYYY-MM-DD");
  }

  return {
    source: "roadrun",
    source_id: no,
    source_url: url,
    race_name: raceName,
    race_datetime: raceDatetime,
    course,
    location_full: locationFull,
    entry_period_raw: entryRaw,
    entry_start: entryStart,
    entry_end: entryEnd,
    homepage
  };
}

// 메인 실행
async function main() {
  try {
    const nos = await fetchListNos(YEARS);

    const results = [];
    for (const no of nos) {
      try {
        const race = await fetchRaceDetail(no);
        results.push(race);

        await upsertRaceToNotion(race); // ← 이 줄
      } catch (err) {
        console.error(`[ERROR] detail no=${no}`, err.message);
      }
    }

    // 출력 디렉토리 보장
    const outDir = path.join(process.cwd(), "output");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, "roadrun.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`[DONE] Saved ${results.length} records to ${outPath}`);
  } catch (err) {
    console.error("[FATAL]", err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}