// Prompts da arte, um por tipo de pet. A composição é sempre a mesma (o enfeite
// sai igual para qualquer foto); o que muda são os detalhes de cada animal.

export const SPECIES = ["gato", "cachorro", "ave", "roedor"] as const;
export type Species = typeof SPECIES[number];

const COMPOSITION = (subject: string, pose: string) => `COMPOSITION (always identical, no matter how the photo looks): pure white square canvas. Centered on it, one large perfect circle drawn with a thick black ring; the inside of the circle is pure white too. The circle fills about 80% of the canvas width. The ${subject} is shown from the chest up, facing the viewer, head centered and upright, looking straight at the camera, peeking out of the ring: ${pose} The tips of the ears or head feathers may slightly overlap the top of the ring. Symmetrical friendly pose.`;

const DETAILS: Record<Species, { subject: string; pose: string; features: string }> = {
  gato: {
    subject: "cat",
    pose: "both front paws rest on the lower edge of the ring and overlap it.",
    features: `CAT FEATURES (priority when choosing the colours): cats' eyes are their most striking feature. Draw large almond eyes and keep the REAL iris colour from the photo (yellow, amber, green, blue or copper) as one solid flat colour, with a black vertical pupil and one small white highlight. Keep a pink nose if the cat has one (otherwise black or the coat colour). Pointed ears with the inner ear in a coat colour or pink only if pink is already used for the nose. No whisker lines. Mouth closed with a gentle smile.`,
  },
  cachorro: {
    subject: "dog",
    pose: "both front paws rest on the lower edge of the ring and overlap it.",
    features: `DOG FEATURES (priority when choosing the colours): the coat and its markings define the dog. Use the main coat colour and, if present, ONE contrasting marking colour (e.g. tan points, white blaze, spots). Eyes dark brown or black, round, with one small white highlight — use another eye colour only if it is striking in the photo (e.g. blue husky eyes). Nose black unless clearly brown or pink in the photo. Keep the exact ear shape (floppy, pointed, half-folded). Mouth closed with a gentle smile.`,
  },
  ave: {
    subject: "bird",
    pose: "its two feet grip the lower edge of the ring like a perch and overlap it.",
    features: `BIRD FEATURES (priority when choosing the colours): plumage colours define the bird. Use the dominant plumage colour and the most striking secondary colour (cheek patch, crest, chest or wing colour). The beak keeps its real colour if it is one of the chosen colours, otherwise draw it in the closest chosen colour. Round eye with a black pupil and one small white highlight. Feathers as large flat shapes, no individual feather lines.`,
  },
  roedor: {
    subject: "small pet (hamster, guinea pig, rabbit, chinchilla or similar)",
    pose: "both tiny front paws rest on the lower edge of the ring and overlap it.",
    features: `SMALL PET FEATURES (priority when choosing the colours): round chubby body, big round shiny black eyes with one small white highlight (red or pink eyes only if clearly so in the photo). Keep a pink nose and pink inner ears when the animal has them — they are part of its charm. Use the main coat colour and at most one patch colour. Keep the real ear size and shape (tiny round ears for hamsters, long ears for rabbits).`,
  },
};

export function artPrompt(species: string, maxColors: number, filamentNames: string[]): string {
  const d = DETAILS[(SPECIES as readonly string[]).includes(species) ? species as Species : "cachorro"];
  const extra = Math.max(0, maxColors - 2);
  const palette = filamentNames.length
    ? ` Prefer colours close to these available filaments: ${filamentNames.join(", ")}.`
    : "";
  return `Turn the ${d.subject} in the photo into a minimalist flat sticker-style illustration for a round Christmas-tree ornament that will be 3D printed in ${maxColors} filament colours.

${COMPOSITION(d.subject, d.pose)}

COLOURS (strict): the whole image uses AT MOST ${maxColors} flat colours: pure black for every outline and the pupils; pure white for the background and for white or very light fur/feathers; plus at most ${extra} other colour${extra === 1 ? "" : "s"}, clearly different from each other and from black and white.${palette} Choose those ${extra} colour${extra === 1 ? "" : "s"} for the features that make THIS animal recognisable (see below), not for shading. Never use two similar shades of the same colour, no gradients, no shadows. For a black or very dark coat, keep the fur pure black and draw its few inner detail lines (around the eyes, mouth, toes) in white so they stay visible; spend a colour on grey only if a colour is left over after the distinctive features.

${d.features}

STYLE: clean vector cartoon, uniform thick black outlines, flat solid fills only. Bold simple shapes and large colour areas that can be 3D printed: no hair-thin lines, no tiny dots, no texture, no fur strokes beyond a few short thick ones, no background scene, no text, no collar, no accessories, no drop shadow.

LIKENESS: keep the real breed features, ear shape, coat colours and markings so the owner recognises the pet instantly. Ignore the photo's background, pose, people and objects. If there is more than one animal, draw only the most prominent one.`;
}
