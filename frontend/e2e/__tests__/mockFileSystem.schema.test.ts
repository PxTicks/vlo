// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
    ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
    COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
    PROJECT_MANIFEST_SCHEMA_VERSION,
    TIMELINE_DOCUMENT_SCHEMA_VERSION,
} from '../../src/features/project/constants';
import {
    assetIndexDocumentSchema,
    assetMetadataDocumentSchema,
    compositeLibraryDocumentSchema,
    projectManifestDocumentSchema,
    timelineDocumentSchema,
} from '../../src/features/project/schemas/projectPersistenceSchemas';
import { createProjectPersistenceDocuments } from '../../src/features/project/services/ProjectPersistenceService';
import {
    MockFileSystem,
    createCurrentProjectDocuments,
    detectContentType,
} from '../mockFileSystem';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIRECTORY = path.join(TEST_DIRECTORY, '..', 'fixtures');
const PROJECT_DIRECTORY = '.vloproject';
const LEGACY_FIXTURES = [
    'project_v1',
    'project_v2_with_clips',
    'project_v3_with_audio_track',
] as const;

function fixturePath(fixture: string, relativePath = ''): string {
    return path.join(FIXTURES_DIRECTORY, fixture, relativePath);
}

function sortedKeys(value: object): string[] {
    return Object.keys(value).sort();
}

describe('MockFileSystem project document conformance', () => {
    it.each(LEGACY_FIXTURES)(
        'upcasts %s into documents accepted by the current schemas',
        (fixture) => {
            const fileSystem = new MockFileSystem(fixturePath(fixture));

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

            expect(fileSystem.wasLegacyProjectConverted).toBe(true);
            expect(manifest.schemaVersion).toBe(PROJECT_MANIFEST_SCHEMA_VERSION);
            expect(timeline.schemaVersion).toBe(TIMELINE_DOCUMENT_SCHEMA_VERSION);
            expect(assets.schemaVersion).toBe(ASSET_INDEX_DOCUMENT_SCHEMA_VERSION);
            expect(composites.schemaVersion).toBe(
                COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
            );
            expect(timeline.transitions).toEqual([]);
        },
    );

    it.each(LEGACY_FIXTURES)(
        'keeps %s structurally congruent with the production writer',
        (fixture) => {
            const legacyProject = JSON.parse(
                fs.readFileSync(
                    fixturePath(fixture, `${PROJECT_DIRECTORY}/project.json`),
                    'utf8',
                ),
            ) as Record<string, unknown>;
            const converted = createCurrentProjectDocuments(legacyProject);
            const parsed = {
                manifest: projectManifestDocumentSchema.parse(converted.manifest),
                timeline: timelineDocumentSchema.parse(converted.timeline),
                assetIndex: assetIndexDocumentSchema.parse(converted.assets),
                compositeLibrary: compositeLibraryDocumentSchema.parse(
                    converted.composites,
                ),
            };
            const writerDocuments = createProjectPersistenceDocuments({
                id: parsed.manifest.id,
                title: parsed.manifest.title,
                createdAt: parsed.manifest.created_at,
                config: parsed.manifest.config,
                timeline: parsed.timeline,
                assetIndex: parsed.assetIndex,
                compositeLibrary: parsed.compositeLibrary,
            });

            for (const documentName of [
                'manifest',
                'timeline',
                'assetIndex',
                'compositeLibrary',
            ] as const) {
                const convertedDocument = parsed[documentName];
                const writerDocument = JSON.parse(
                    JSON.stringify(writerDocuments[documentName]),
                ) as typeof convertedDocument;
                expect(sortedKeys(convertedDocument)).toEqual(
                    sortedKeys(writerDocument),
                );
                expect(writerDocument.documentType).toBe(
                    convertedDocument.documentType,
                );
                expect(writerDocument.schemaVersion).toBe(
                    convertedDocument.schemaVersion,
                );
            }
        },
    );

    it('passes a current-format fixture through byte-for-byte', () => {
        const projectRoot = fixturePath('project_current');
        const documentPaths = [
            'project.json',
            'timeline.json',
            'assets.json',
            'composites.json',
        ];
        const before = new Map(
            documentPaths.map((documentPath) => [
                documentPath,
                fs.readFileSync(
                    path.join(projectRoot, PROJECT_DIRECTORY, documentPath),
                ),
            ]),
        );

        const fileSystem = new MockFileSystem(projectRoot);

        expect(fileSystem.wasLegacyProjectConverted).toBe(false);
        for (const documentPath of documentPaths) {
            expect(
                fileSystem.readBuffer(`${PROJECT_DIRECTORY}/${documentPath}`),
            ).toEqual(before.get(documentPath));
        }
    });

    it('parses the current fixture and its asset metadata at current versions', () => {
        const fileSystem = new MockFileSystem(fixturePath('project_current'));
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
        expect(timeline.tracks).toHaveLength(8);
        expect(timeline.clips).toHaveLength(12);
        expect(timeline.transitions).toHaveLength(1);

        for (const metadataFile of fileSystem.list(
            `${PROJECT_DIRECTORY}/asset-metadata`,
        )) {
            const metadata = assetMetadataDocumentSchema.parse(
                fileSystem.readJson(
                    `${PROJECT_DIRECTORY}/asset-metadata/${metadataFile}`,
                ),
            );
            expect(metadata.schemaVersion).toBe(
                ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
            );
        }
    });
});

describe('MockFileSystem content types', () => {
    it.each([
        ['audio.m4a', 'audio/mp4'],
        ['video.m4v', 'video/x-m4v'],
        ['video.mov', 'video/quicktime'],
        ['audio.ogg', 'audio/ogg'],
        ['audio.opus', 'audio/opus'],
        ['image.avif', 'image/avif'],
        ['composite.webm', 'video/webm'],
    ])('serves %s as %s', (fileName, expectedContentType) => {
        expect(detectContentType(fileName, Buffer.alloc(16))).toBe(
            expectedContentType,
        );
    });

    /**
     * The fixture's real .m4a opens with an `ftyp` box, which the magic-byte
     * fallback classifies as video/mp4. Zero-filled bodies cannot express that,
     * so this pins extension lookup as taking precedence over sniffing rather
     * than merely pinning the map entry.
     */
    it('prefers the extension over ftyp sniffing for real audio containers', () => {
        const fileSystem = new MockFileSystem(fixturePath('project_current'));
        const audioFile = fileSystem
            .listFiles()
            .find((filePath) => filePath.endsWith('.m4a'));
        expect(audioFile).toBeDefined();

        const body = fileSystem.readBuffer(audioFile as string);
        expect(body.subarray(4, 8).toString('ascii')).toBe('ftyp');
        expect(detectContentType(audioFile as string, body)).toBe('audio/mp4');
    });
});
