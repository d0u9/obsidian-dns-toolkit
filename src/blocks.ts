export interface BlockType {
	type: string;
	description: string;
	/** Written into the editor instead of the bare type when it needs an attribute. */
	snippet?: string;
}

export const SUPPORTED_BLOCKS: readonly BlockType[] = [
	{ type: 'lead', description: 'Opening introduction' },
	{ type: 'epigraph', description: 'Quotation or epigraph' },
	{ type: 'poem', description: 'Verse with stanza spacing' },
	{ type: 'aside', description: 'Supporting note or context' },
	{ type: 'imgcap', description: 'Image caption' },
	{ type: 'compnote', description: 'Closing composition note' },
	{
		type: 'center',
		description: 'Centered text; adjust the height value as needed',
		snippet: 'center{height=120px}',
	},
	{
		type: 'spacer',
		description: 'Vertical blank space; adjust the height value as needed',
		snippet: 'spacer{height=5rem}',
	},
];

export function blockExample(block: BlockType): string {
	return `:::${block.snippet ?? block.type}`;
}
