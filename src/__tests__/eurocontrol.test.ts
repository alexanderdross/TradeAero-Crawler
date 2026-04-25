import { describe, it, expect } from "vitest";
import {
  parseEurocontrolPage,
  parseEurocontrolLastPageIndex,
} from "../parsers/eurocontrol.js";

const PAGE_URL = "https://www.eurocontrol.int/events";
const SOURCE = "eurocontrol.int";

const card = (opts: {
  type?: string;
  start?: string;
  end?: string;
  startLabel?: string;
  endLabel?: string;
  title?: string;
  href?: string;
  multiTime?: boolean;
} = {}) => {
  const {
    type = "Event",
    start = "2026-05-06T07:30:00Z",
    end,
    startLabel = "6 May 2026",
    endLabel,
    title = "2026 EU MITRE ATT&CK® Community Workshop",
    href = "/event/2026-eu-mitre-attckr-community-workshop",
    multiTime = false,
  } = opts;
  const dateInner = multiTime
    ? `<time datetime="${start}">${startLabel}</time> - <time datetime="${end}">${endLabel}</time>`
    : `<time datetime="${start}">${startLabel}</time>`;
  return `
    <div class="node node--event card">
      <div class="card-img-top"></div>
      <div class="card-header">
        <div class="field--ref-event-type">${type}</div>
      </div>
      <div class="card-body">
        <div class="field--date-range">
          <div class="field__item">${dateInner}</div>
        </div>
        <div class="field--promo-title"><h3 class="h5">${title}</h3></div>
      </div>
      <div class="card-footer">
        <a href="${href}" class="btn">Register</a>
      </div>
    </div>
  `;
};

const wrap = (...cards: string[]) => `<html><body>${cards.join("\n")}</body></html>`;

describe("parseEurocontrolPage", () => {
  it("returns [] on a page with no event cards", () => {
    expect(parseEurocontrolPage("<html></html>", PAGE_URL, SOURCE)).toEqual([]);
  });

  it("parses a single-day card", () => {
    const events = parseEurocontrolPage(wrap(card()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("2026 EU MITRE ATT&CK® Community Workshop");
    expect(e.startDate).toBe("2026-05-06T00:00:00.000Z");
    expect(e.endDate).toBe("2026-05-06T00:00:00.000Z");
    expect(e.country).toBe("BE");
    expect(e.organizerName).toBe("Eurocontrol");
    expect(e.timezone).toBe("UTC");
    expect(e.sourceLocale).toBe("en");
    expect(e.subtitle).toBe("Event");
    expect(e.sourceUrl).toBe(
      "https://www.eurocontrol.int/event/2026-eu-mitre-attckr-community-workshop",
    );
  });

  it("parses cross-day events using the first/last <time> datetime attrs", () => {
    const events = parseEurocontrolPage(
      wrap(
        card({
          start: "2026-06-03T10:00:00Z",
          end: "2026-06-04T07:00:00Z",
          startLabel: "3",
          endLabel: "4 June 2026",
          title: "Point Merge Stakeholder Event",
          href: "/event/point-merge-stakeholder",
          multiTime: true,
        }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].startDate).toBe("2026-06-03T00:00:00.000Z");
    expect(events[0].endDate).toBe("2026-06-04T00:00:00.000Z");
  });

  it("classifies Webinar / Workshop / Event types", () => {
    const events = parseEurocontrolPage(
      wrap(
        card({ type: "Webinar", title: "Aviation Engage", href: "/event/a" }),
        card({ type: "Workshop", title: "ATM Workshop", href: "/event/b" }),
        card({ type: "Conference", title: "Aviation Inclusion", href: "/event/c" }),
        card({ type: "Event", title: "Civil-Military ATM Cooperation Forum", href: "/event/d" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events.map((e) => e.categoryCode)).toEqual([
      "webinar",
      "seminar",
      "seminar",
      "seminar",
    ]);
  });

  it("falls back to title-keyword classification when type is generic 'Event'", () => {
    const events = parseEurocontrolPage(
      wrap(
        card({ type: "Event", title: "Aviation Engage Awards Gala 2026", href: "/event/x" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].categoryCode).toBe("general");
  });

  it("skips cards with no title", () => {
    const noTitle = `
      <div class="node node--event card">
        <div class="card-body">
          <div class="field--date-range">
            <div class="field__item"><time datetime="2026-05-06T07:30:00Z">6 May 2026</time></div>
          </div>
          <div class="field--promo-title"></div>
        </div>
      </div>`;
    const events = parseEurocontrolPage(wrap(noTitle, card()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
  });

  it("skips cards with no <time datetime>", () => {
    const noDate = `
      <div class="node node--event card">
        <div class="card-body">
          <div class="field--date-range"><div class="field__item">TBC</div></div>
          <div class="field--promo-title"><h3 class="h5">Untimed</h3></div>
        </div>
      </div>`;
    const events = parseEurocontrolPage(wrap(noDate, card()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
  });

  it("synthesises sourceUrl when card-footer href is empty", () => {
    const noHref = `
      <div class="node node--event card">
        <div class="card-body">
          <div class="field--date-range">
            <div class="field__item"><time datetime="2026-05-06T07:30:00Z">6 May 2026</time></div>
          </div>
          <div class="field--promo-title"><h3 class="h5">Hidden Card</h3></div>
        </div>
      </div>`;
    const events = parseEurocontrolPage(wrap(noHref), PAGE_URL, SOURCE);
    expect(events[0].sourceUrl).toMatch(
      /^https:\/\/www\.eurocontrol\.int\/events#[a-f0-9]{16}$/,
    );
  });

  it("preserves multiple cards", () => {
    const events = parseEurocontrolPage(
      wrap(
        card({ href: "/event/a", title: "A" }),
        card({ href: "/event/b", title: "B" }),
        card({ href: "/event/c", title: "C" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.title)).toEqual(["A", "B", "C"]);
  });

  it("handles absolute href without re-prefixing the host", () => {
    const events = parseEurocontrolPage(
      wrap(card({ href: "https://www.eurocontrol.int/event/external" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].sourceUrl).toBe(
      "https://www.eurocontrol.int/event/external",
    );
  });

  it("includes the event type in subtitle and description", () => {
    const events = parseEurocontrolPage(
      wrap(card({ type: "Webinar", title: "Quarterly briefing" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].subtitle).toBe("Webinar");
    expect(events[0].description).toContain("Webinar");
    expect(events[0].description).toContain("Quarterly briefing");
  });
});

describe("parseEurocontrolLastPageIndex", () => {
  it("returns 0 when no pager is present", () => {
    expect(parseEurocontrolLastPageIndex("<html></html>")).toBe(0);
  });

  it("returns the largest visible 0-based page index", () => {
    const html = `
      <ul class="pagination">
        <li><a href="?page=1">2</a></li>
        <li><a href="?page=2">3</a></li>
        <li><a href="?page=7" rel="last">8</a></li>
      </ul>`;
    expect(parseEurocontrolLastPageIndex(html)).toBe(7);
  });

  it("clamps to 19 (maximum 20 pages)", () => {
    const html = `<a href="?page=200">201</a>`;
    expect(parseEurocontrolLastPageIndex(html)).toBe(19);
  });
});
