// src/notion.mjs
import pkg from "@notionhq/client";

const { Client } = pkg;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;
const NOTION_VERSION = "2022-06-28"; // 안정된 버전

const notion = new Client({ auth: NOTION_TOKEN });

// 디버그용은 이제 필요 없으니 제거해도 됨
// console.log(
//   "[DEBUG] typeof notion.databases:",
//   typeof notion.databases,
//   "typeof notion.databases?.query:",
//   typeof notion.databases?.query
// );

function buildProperties(race) {
  const courseList = race.Course || race.course || race.categories || [];

  let raceStart = null;
  if (race.race_datetime) {
    // "2026-01-11 09:30" → "2026-01-11T09:30+09:00" (KST)
    raceStart = race.race_datetime.replace(" ", "T") + "+09:00";
  }

  const props = {
    Name: {
      title: [{ text: { content: race.race_name || "(제목 없음)" } }],
    },
    Location: {
      rich_text: [{ text: { content: race.location_full || "" } }],
    },
    Course: {
      multi_select: courseList.map((name) => ({ name })),
    },
  };

  if (raceStart) {
    props["Race DateTime"] = {
      date: { start: raceStart },
    };
  }
  if (race.entry_start) {
    props["Entry Start"] = {
      date: { start: race.entry_start },
    };
  }
  if (race.entry_end) {
    props["Entry End"] = {
      date: { start: race.entry_end },
    };
  }
  if (race.homepage) {
    props["URL"] = {
      url: race.homepage,
    };
  }

  return props;
}

// 🔹 SDK 대신 fetch로 DB query
async function queryByRaceName(name) {
  if (!DB_ID) {
    console.warn("NOTION_DB_ID not set, skip query");
    return [];
  }
  if (!NOTION_TOKEN) {
    console.warn("NOTION_TOKEN not set, skip query");
    return [];
  }

  const res = await fetch(
      `https://api.notion.com/v1/databases/${DB_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            property: "Name",
            title: { equals: name }
          }
        }),
      }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(
        `[NOTION] query failed (${res.status} ${res.statusText}): ${text}`
    );
    return [];
  }

  const data = await res.json();
  return data.results ?? [];
}

// 🔹 upsert: query는 fetch, create/update는 SDK
export async function upsertRaceToNotion(race) {
  if (!DB_ID) {
    console.warn("NOTION_DB_ID not set, skip Notion sync");
    return;
  }

  const existing = await queryByRaceName(race.race_name);
  const properties = buildProperties(race);

  if (existing.length > 0) {
    const pageId = existing[0].id;
    await notion.pages.update({
      page_id: pageId,
      properties,
    });
    console.log(`[NOTION] updated page for ${race.race_name}`);
  } else {
    await notion.pages.create({
      parent: { database_id: DB_ID },
      properties,
    });
    console.log(`[NOTION] created page for ${race.race_name}`);
  }
}