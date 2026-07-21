import {
    ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
    ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
    COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
    PROJECT_MANIFEST_SCHEMA_VERSION,
    TIMELINE_DOCUMENT_SCHEMA_VERSION,
} from '../src/features/project/constants';
import {
    assetIndexDocumentSchema,
    assetMetadataDocumentSchema,
    compositeLibraryDocumentSchema,
    projectManifestDocumentSchema,
    timelineDocumentSchema,
} from '../src/features/project/schemas/projectPersistenceSchemas';
import { expect, test } from './fixtures';

const PROJECT_DIRECTORY = '.vloproject';
const CORE_DOCUMENTS = [
    'timeline.json',
    'assets.json',
    'composites.json',
] as const;

test.describe('Current project format', () => {
    test('@smoke edits and reopens a writer-produced project losslessly', async ({
        editorCurrent,
    }) => {
        const { fileSystem, page } = editorCurrent;
        const retainedPaths = fileSystem
            .listFiles(PROJECT_DIRECTORY)
            .filter((filePath) => filePath !== `${PROJECT_DIRECTORY}/project.json`);
        const retainedBefore = new Map(
            retainedPaths.map((filePath) => [
                filePath,
                fileSystem.readBuffer(filePath),
            ]),
        );
        const initialTimeline = timelineDocumentSchema.parse(
            fileSystem.readJson(`${PROJECT_DIRECTORY}/timeline.json`),
        );

        await page.getByTestId('project-title-display').click();
        const titleInput = page.getByTestId('project-title-input').locator('input');
        await titleInput.fill('Current Format Round Trip');
        await titleInput.press('Enter');

        await expect.poll(() =>
            projectManifestDocumentSchema.parse(
                fileSystem.readJson(`${PROJECT_DIRECTORY}/project.json`),
            ).title,
        ).toBe('Current Format Round Trip');

        await editorCurrent.reopenProject();
        await expect(page.getByTestId('project-title-display')).toHaveText(
            'Current Format Round Trip',
        );

        const manifest = projectManifestDocumentSchema.parse(
            fileSystem.readJson(`${PROJECT_DIRECTORY}/project.json`),
        );
        const timeline = timelineDocumentSchema.parse(
            fileSystem.readJson(`${PROJECT_DIRECTORY}/timeline.json`),
        );
        const assets = assetIndexDocumentSchema.parse(
            fileSystem.readJson(`${PROJECT_DIRECTORY}/assets.json`),
        );
        const composites = compositeLibraryDocumentSchema.parse(
            fileSystem.readJson(`${PROJECT_DIRECTORY}/composites.json`),
        );

        expect(manifest.schemaVersion).toBe(PROJECT_MANIFEST_SCHEMA_VERSION);
        expect(timeline.schemaVersion).toBe(TIMELINE_DOCUMENT_SCHEMA_VERSION);
        expect(assets.schemaVersion).toBe(ASSET_INDEX_DOCUMENT_SCHEMA_VERSION);
        expect(composites.schemaVersion).toBe(
            COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
        );
        expect(timeline.transitions).toEqual(initialTimeline.transitions);

        const metadataPaths = retainedPaths.filter((filePath) =>
            filePath.startsWith(`${PROJECT_DIRECTORY}/asset-metadata/`),
        );
        expect(metadataPaths.length).toBeGreaterThan(0);
        for (const metadataPath of metadataPaths) {
            const metadata = assetMetadataDocumentSchema.parse(
                fileSystem.readJson(metadataPath),
            );
            expect(metadata.schemaVersion).toBe(
                ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
            );
        }

        // Saving the manifest must retain every independent project document and
        // auxiliary artefact (metadata, masks, proxies and thumbnails) byte-for-byte.
        expect(retainedPaths).toEqual(fileSystem.listFiles(PROJECT_DIRECTORY).filter(
            (filePath) => filePath !== `${PROJECT_DIRECTORY}/project.json`,
        ));
        for (const retainedPath of retainedPaths) {
            expect(fileSystem.readBuffer(retainedPath)).toEqual(
                retainedBefore.get(retainedPath),
            );
        }

        for (const documentPath of CORE_DOCUMENTS) {
            expect(fileSystem.exists(`${PROJECT_DIRECTORY}/${documentPath}`)).toBe(
                true,
            );
        }
    });
});
