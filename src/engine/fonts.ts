// Typefaces available to the artist. Files live in public/fonts (see scripts/fetch-fonts.ts).
export interface FontSpec {
  id: string;        // fontsource id / file prefix
  family: string;    // CSS family name the artist uses
  weights: number[];
  italic?: boolean;
  character: string; // one-line description for the artist's manual
}

export const FONTS: FontSpec[] = [
  { id: 'inter', family: 'Inter', weights: [300, 400, 700, 900], character: 'neutral contemporary grotesque sans' },
  { id: 'playfair-display', family: 'Playfair Display', weights: [400, 700, 900], italic: true, character: 'high-contrast transitional serif, elegant/editorial' },
  { id: 'cormorant-garamond', family: 'Cormorant Garamond', weights: [300, 500, 700], italic: true, character: 'delicate classical old-style serif' },
  { id: 'space-mono', family: 'Space Mono', weights: [400, 700], character: 'geometric monospace, technical' },
  { id: 'bebas-neue', family: 'Bebas Neue', weights: [400], character: 'tall condensed all-caps display sans, poster' },
  { id: 'archivo-black', family: 'Archivo Black', weights: [400], character: 'heavy wide grotesque, blunt and loud' },
  { id: 'syne', family: 'Syne', weights: [400, 700, 800], character: 'eccentric art-world display sans' },
  { id: 'caveat', family: 'Caveat', weights: [400, 700], character: 'casual handwritten marker script' },
  { id: 'unifrakturmaguntia', family: 'UnifrakturMaguntia', weights: [400], character: 'blackletter / fraktur' },
];

export const fontFile = (id: string, weight: number, style: string) => `${id}-${weight}-${style}.ttf`;
