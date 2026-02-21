/**
 * Parser for CyLaw consolidated legislation pages.
 *
 * Expected source format:
 *   https://www.cylaw.org/nomoi/enop/non-ind/{YYYY}_{PART}_{NUMBER}/full.html
 */

export interface TargetLaw {
  order: number;
  id: string;
  pathStem: string;
  shortName: string;
  titleEn: string;
  description: string;
}

export interface ParsedProvision {
  provision_ref: string;
  chapter?: string;
  section: string;
  title: string;
  content: string;
}

export interface ParsedDefinition {
  term: string;
  definition: string;
  source_provision?: string;
}

export interface ParsedAct {
  id: string;
  type: 'statute';
  title: string;
  title_en: string;
  short_name: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issued_date?: string;
  in_force_date?: string;
  url: string;
  description?: string;
  provisions: ParsedProvision[];
  definitions: ParsedDefinition[];
}

export const TARGET_CYPRIOT_LAWS: TargetLaw[] = [
  {
    order: 1,
    id: 'cy-data-protection-125-2018',
    pathStem: '2018_1_125',
    shortName: 'Ν. 125(I)/2018',
    titleEn: 'Law on the Protection of Natural Persons regarding Personal Data Processing (2018)',
    description:
      'Primary Cypriot data protection statute implementing and supplementing the GDPR framework in Cyprus.',
  },
  {
    order: 2,
    id: 'cy-law-enforcement-data-44-2019',
    pathStem: '2019_1_44',
    shortName: 'Ν. 44(I)/2019',
    titleEn: 'Law on Personal Data Processing by Competent Authorities (2019)',
    description:
      'Cypriot law governing personal data processing by competent authorities for criminal-law purposes.',
  },
  {
    order: 3,
    id: 'cy-network-information-security-89-2020',
    pathStem: '2020_1_89',
    shortName: 'Ν. 89(I)/2020',
    titleEn: 'Security of Networks and Information Systems Law (2020)',
    description:
      'National cybersecurity law on security obligations and incident governance for network and information systems.',
  },
  {
    order: 4,
    id: 'cy-electronic-communications-112-2004',
    pathStem: '2004_1_112',
    shortName: 'Ν. 112(I)/2004',
    titleEn: 'Electronic Communications and Postal Services Regulation Law (2004)',
    description:
      'Core communications-sector statute establishing regulatory obligations for electronic communications and postal services.',
  },
  {
    order: 5,
    id: 'cy-ecommerce-156-2004',
    pathStem: '2004_1_156',
    shortName: 'Ν. 156(I)/2004',
    titleEn: 'Information Society Services and Electronic Commerce Law (2004)',
    description:
      'Framework law on legal aspects of information society services and electronic commerce in Cyprus.',
  },
  {
    order: 6,
    id: 'cy-eidas-55-2018',
    pathStem: '2018_1_55',
    shortName: 'Ν. 55(I)/2018',
    titleEn: 'eIDAS Implementation Law (2018)',
    description:
      'Cypriot implementation law for Regulation (EU) No 910/2014 on electronic identification and trust services.',
  },
  {
    order: 7,
    id: 'cy-trade-secrets-164-2020',
    pathStem: '2020_1_164',
    shortName: 'Ν. 164(I)/2020',
    titleEn: 'Trade Secrets Protection Law (2020)',
    description:
      'Law protecting undisclosed know-how and business information against unlawful acquisition, use, and disclosure.',
  },
  {
    order: 8,
    id: 'cy-telecom-data-retention-183-2007',
    pathStem: '2007_1_183',
    shortName: 'Ν. 183(I)/2007',
    titleEn: 'Telecommunications Data Retention Law (2007)',
    description:
      'Law governing retention of telecommunications data for investigation of serious criminal offenses.',
  },
  {
    order: 9,
    id: 'cy-attacks-on-information-systems-147-2015',
    pathStem: '2015_1_147',
    shortName: 'Ν. 147(I)/2015',
    titleEn: 'Attacks against Information Systems Law (2015)',
    description:
      'Criminal-law statute addressing offenses against information systems and related investigative powers.',
  },
  {
    order: 10,
    id: 'cy-open-data-143-2021',
    pathStem: '2021_1_143',
    shortName: 'Ν. 143(I)/2021',
    titleEn: 'Open Data and Re-use of Public Sector Information Law (2021)',
    description:
      'Law on open data and re-use of public sector documents and information in Cyprus.',
  },
];

const GREEK_TO_LATIN: Record<string, string> = {
  Α: 'A', α: 'a',
  Β: 'V', β: 'v',
  Γ: 'G', γ: 'g',
  Δ: 'D', δ: 'd',
  Ε: 'E', ε: 'e',
  Ζ: 'Z', ζ: 'z',
  Η: 'I', η: 'i',
  Θ: 'Th', θ: 'th',
  Ι: 'I', ι: 'i',
  Κ: 'K', κ: 'k',
  Λ: 'L', λ: 'l',
  Μ: 'M', μ: 'm',
  Ν: 'N', ν: 'n',
  Ξ: 'X', ξ: 'x',
  Ο: 'O', ο: 'o',
  Π: 'P', π: 'p',
  Ρ: 'R', ρ: 'r',
  Σ: 'S', σ: 's', ς: 's',
  Τ: 'T', τ: 't',
  Υ: 'Y', υ: 'y',
  Φ: 'F', φ: 'f',
  Χ: 'Ch', χ: 'ch',
  Ψ: 'Ps', ψ: 'ps',
  Ω: 'O', ω: 'o',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code) => {
      const cp = Number.parseInt(code, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => {
      const cp = Number.parseInt(code, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»');
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '');

  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(stripped).replace(/\u00a0/g, ' ');

  return decoded
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function cleanInlineText(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}

function normalizeForProvisionRef(section: string, fallbackIndex: number): string {
  let latin = '';

  for (const ch of section) {
    latin += GREEK_TO_LATIN[ch] ?? ch;
  }

  const cleaned = latin.replace(/[^A-Za-z0-9]/g, '');
  const base = cleaned.length > 0 ? cleaned : String(fallbackIndex);
  return `sec${base}`;
}

function extractMainContent(fullHtml: string): string {
  const main = fullHtml.match(/<div class="main-content">([\s\S]*?)<div class="footer">/i)?.[1];
  return main ?? fullHtml;
}

function extractLawTitle(fullHtml: string): string | undefined {
  const h1 = fullHtml.match(/<h1>([\s\S]*?)<\/h1>/i)?.[1];
  if (!h1) return undefined;
  return cleanInlineText(h1);
}

function toIsoDate(dmy: string): string | undefined {
  const m = dmy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;

  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3];

  return `${year}-${month}-${day}`;
}

function extractIssueDate(indexHtml?: string): string | undefined {
  if (!indexHtml) return undefined;
  const text = htmlToText(indexHtml);
  const match = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  if (!match) return undefined;
  return toIsoDate(match[1]);
}

function extractSectionNumber(content: string, header: string, fallbackIndex: number): string {
  const start = content.replace(/\s+/g, ' ').trim();

  const fromContent = start.match(/^(\d+[A-Za-zΑ-Ωα-ω]*)\s*(?:[.)]|-\s*\()/u)?.[1]
    ?? start.match(/^Άρθρο\s+(\d+[A-Za-zΑ-Ωα-ω]*)/iu)?.[1];
  if (fromContent) return fromContent;

  const fromHeader = header.match(/^(\d+[A-Za-zΑ-Ωα-ω]*)\b/u)?.[1];
  if (fromHeader) return fromHeader;

  return String(fallbackIndex);
}

function findNearestDivisionHeader(mainHtml: string, pos: number): string | undefined {
  const before = mainHtml.slice(Math.max(0, pos - 50000), pos);
  const matches = [...before.matchAll(/<div class="full-division-header">([\s\S]*?)<\/div>/gi)];
  if (matches.length === 0) return undefined;
  return cleanInlineText(matches[matches.length - 1][1]);
}

function extractDefinitions(content: string, sourceProvision: string, sink: ParsedDefinition[]): void {
  const seen = new Set(sink.map(d => `${d.term}::${d.definition}`));

  const regexes: RegExp[] = [
    /«\s*([^»]{2,120}?)\s*»\s*(?:σημαίνει|σημαίνουν|έχει\s+την\s+έννοια)\s+([^.;\n]{5,700})/giu,
    /"\s*([^"\n]{2,120}?)\s*"\s*(?:means|shall\s+mean)\s+([^.;\n]{5,700})/giu,
  ];

  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const term = match[1].replace(/\s+/g, ' ').trim();
      const definition = match[2].replace(/\s+/g, ' ').trim();
      if (term.length < 2 || definition.length < 5) continue;

      const dedupe = `${term}::${definition}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      sink.push({
        term,
        definition,
        source_provision: sourceProvision,
      });
    }
  }
}

export function getLawUrls(target: TargetLaw): { fullUrl: string; indexUrl: string } {
  return {
    fullUrl: `https://www.cylaw.org/nomoi/enop/non-ind/${target.pathStem}/full.html`,
    indexUrl: `https://www.cylaw.org/nomoi/indexes/${target.pathStem}.html`,
  };
}

export function parseCyLawHtml(fullHtml: string, target: TargetLaw, indexHtml?: string): ParsedAct {
  const mainHtml = extractMainContent(fullHtml);
  const starts = [...mainHtml.matchAll(/<div class="full-section">/gi)].map(m => m.index ?? 0);

  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : mainHtml.length;
    const chunk = mainHtml.slice(start, end);

    const headerHtml = chunk.match(/<div class="full-section-header">([\s\S]*?)<\/div>/i)?.[1] ?? '';
    const textHtml = chunk.match(/<div class="full-section-text">([\s\S]*?)<\/div>/i)?.[1] ?? '';

    if (!textHtml) continue;

    const content = htmlToText(textHtml);
    if (content.length < 3) continue;

    const header = cleanInlineText(headerHtml);
    const section = extractSectionNumber(content, header, i + 1);
    const provisionRef = normalizeForProvisionRef(section, i + 1);
    const chapter = findNearestDivisionHeader(mainHtml, start);

    const title = header.length > 0
      ? `Άρθρο ${section}: ${header}`
      : `Άρθρο ${section}`;

    provisions.push({
      provision_ref: provisionRef,
      chapter,
      section,
      title,
      content,
    });

    if (/ερμηνεία|ορισμ|σημαίνει|means/iu.test(`${header} ${content.slice(0, 500)}`)) {
      extractDefinitions(content, provisionRef, definitions);
    }
  }

  const { fullUrl } = getLawUrls(target);
  const title = extractLawTitle(fullHtml) ?? target.shortName;
  const issueDate = extractIssueDate(indexHtml);

  return {
    id: target.id,
    type: 'statute',
    title,
    title_en: target.titleEn,
    short_name: target.shortName,
    status: 'in_force',
    issued_date: issueDate,
    in_force_date: issueDate,
    url: fullUrl,
    description: target.description,
    provisions,
    definitions,
  };
}
