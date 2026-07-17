import type {
  AlignedGcpCameraRecord,
  GcpOptimizationPublicationRecord,
  ImageQualityAnalysisRecord,
  ImageQualityWarning,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import type { ReactNode } from 'react';

import styles from './ImagePropertiesPanel.module.css';

export function ImagePropertiesPanel({
  image,
  quality,
  aligned,
  optimization,
}: {
  image: ProjectCameraImageRecord;
  quality: ImageQualityAnalysisRecord | null;
  aligned: AlignedGcpCameraRecord | null;
  optimization: GcpOptimizationPublicationRecord | null;
}): JSX.Element {
  const photo = image.metadata.inspectedPhoto;
  const exif = photo.metadata.exif;
  const dji = photo.metadata.djiXmp;
  const gps = dji.latitudeDegrees != null && dji.longitudeDegrees != null
    ? { latitude: dji.latitudeDegrees, longitude: dji.longitudeDegrees, height: dji.absoluteAltitude?.meters }
    : exif.gps
      ? { latitude: exif.gps.latitudeDegrees, longitude: exif.gps.longitudeDegrees, height: exif.gps.altitude?.meters }
      : null;
  const optimized = aligned
    ? optimization?.artifact.result.cameras.find((camera) => camera.imageId === aligned.imageId)
    : undefined;

  return (
    <div className={styles.root}>
      <Section title="Positions">
        <Row label="Original" value={gps ? formatGeographicPosition(gps.longitude, gps.latitude, gps.height) : '—'} />
        <Row
          label="Transformed"
          value={
            image.metadata.projectedReference
              ? formatCartesianPosition([
                  image.metadata.projectedReference.easting,
                  image.metadata.projectedReference.northing,
                  image.metadata.projectedReference.transformedHeightMeters ?? image.metadata.projectedReference.sourceHeightMeters,
                ])
              : '—'
          }
        />
        <Row label="Alignment local" value={aligned ? formatCartesianPosition(aligned.camera.centerReconstruction) : '—'} />
        <Row label="GCP optimized" value={optimized ? formatCartesianPosition(optimized.centerWorldMeters) : '—'} />
      </Section>
      <Section title="Orientation">
        <Row label="Gimbal" value={formatAttitude(dji.gimbalAttitude)} />
        <Row label="Aircraft" value={formatAttitude(dji.flightAttitude)} />
        <Row label="Aligned" value={aligned ? formatMatrix(aligned.camera.cameraToReconstructionRotation) : '—'} />
        <Row label="Optimized" value={optimized ? formatMatrix(optimized.cameraToWorldRotation) : '—'} />
      </Section>
      <Section title="Camera and capture">
        <Row label="Camera" value={[exif.make, exif.model].filter(Boolean).join(' ') || '—'} />
        <Row label="Lens" value={exif.lensModel ?? '—'} />
        <Row label="Dimensions" value={exif.dimensions ? `${exif.dimensions.widthPixels} × ${exif.dimensions.heightPixels} px` : '—'} />
        <Row label="Focal length" value={exif.focalLengthMm == null ? '—' : `${exif.focalLengthMm.toFixed(2)} mm`} />
        <Row label="Capture time" value={exif.capturedAt?.value ?? '—'} />
        <Row label="RTK" value={dji.rtk ? `Flag ${dji.rtk.flag ?? '—'} · σH ${formatSigma(dji.rtk.standardDeviationHeightMeters)}` : '—'} />
      </Section>
      <Section title="Measured image quality">
        {quality?.outcome.status === 'measured' ? (
          <>
            <Row
              label="Sharpness"
              value={`${quality.outcome.metrics.laplacianVariance.toExponential(3)} Laplacian variance · ${quality.outcome.metrics.tenengrad.toExponential(3)} Tenengrad`}
            />
            <Row
              label="Motion blur indicator"
              value={`${(quality.outcome.metrics.directionalGradientCoherence * 100).toFixed(2)}% · ${quality.outcome.metrics.dominantGradientAngleDegrees.toFixed(1)}°`}
            />
            <Row
              label="Exposure"
              value={`Mean ${(quality.outcome.metrics.meanLuminance * 100).toFixed(1)}% · shadows ${(quality.outcome.metrics.shadowClippedFraction * 100).toFixed(2)}% · highlights ${(quality.outcome.metrics.highlightClippedFraction * 100).toFixed(2)}%`}
            />
            <Row
              label="Texture"
              value={`${quality.outcome.metrics.textureEntropyBits.toFixed(3)} bit entropy · ${(quality.outcome.metrics.texturedPixelFraction * 100).toFixed(2)}% textured pixels`}
            />
            <Row
              label="Review flags"
              value={
                quality.outcome.warnings.length > 0
                  ? quality.outcome.warnings.map(formatQualityWarning).join(' · ')
                  : 'None'
              }
            />
            <Row
              label="Sample"
              value={`${quality.sampleWidthPixels} × ${quality.sampleHeightPixels} of ${quality.originalWidthPixels} × ${quality.originalHeightPixels} px · ${quality.algorithmVersion}`}
            />
            <Row label="Scope" value={quality.processingSetId ?? 'Project-wide'} mono={quality.processingSetId !== undefined} />
            <Row label="Analyzed" value={formatAnalysisTimestamp(quality.analyzedAtUnixMs)} />
            <Row label="Analysis job" value={quality.jobId} mono />
            <Row label="Analyzed metadata" value={quality.sourceMetadataObjectHash} mono />
            <Row label="Configuration" value={quality.configurationSha256} mono />
          </>
        ) : quality?.outcome.status === 'unavailable' ? (
          <Row label="Unavailable" value={quality.outcome.reason} />
        ) : (
          <Row label="Analysis" value="Not analyzed" />
        )}
      </Section>
      <Section title="Status">
        <div className={styles.tags}>
          {image.metadata.statusTags.length > 0
            ? image.metadata.statusTags.map((tag) => <span key={tag}>{tag}</span>)
            : <span>imported</span>}
        </div>
        <Row label="Image SHA-256" value={image.metadata.sourceObjectHash} mono />
        <Row label="Metadata SHA-256" value={image.metadataObjectHash} mono />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return <section><h3>{title}</h3>{children}</section>;
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return <div className={styles.row}><span>{label}</span><strong className={mono ? styles.mono : undefined} title={value}>{value}</strong></div>;
}

function formatCartesianPosition(values: readonly [number, number, number | undefined]): string {
  return values
    .map((value, index) => `${['X', 'Y', 'Z'][index]} ${formatNumber(value)}${value == null ? '' : ' m'}`)
    .join(' · ');
}

function formatGeographicPosition(longitude: number, latitude: number, height?: number): string {
  return `Lon ${formatNumber(longitude)}° · Lat ${formatNumber(latitude)}° · h ${formatNumber(height)}${height == null ? '' : ' m'}`;
}

function formatNumber(value: number | undefined): string {
  return value == null
    ? '—'
    : value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}

function formatAttitude(attitude: { yaw?: number; pitch?: number; roll?: number } | undefined): string {
  if (!attitude) return '—';
  return `Y ${attitude.yaw?.toFixed(2) ?? '—'}° · P ${attitude.pitch?.toFixed(2) ?? '—'}° · R ${attitude.roll?.toFixed(2) ?? '—'}°`;
}

function formatMatrix(matrix: readonly number[]): string {
  return matrix.map((value) => value.toFixed(4)).join(' ');
}

function formatSigma(value: number | undefined): string {
  return value == null ? '—' : `${(value * 1000).toFixed(1)} mm`;
}

function formatQualityWarning(warning: ImageQualityWarning): string {
  if (warning === 'shadowClipping') return 'Shadow clipping';
  if (warning === 'highlightClipping') return 'Highlight clipping';
  if (warning === 'lowSharpness') return 'Low sharpness';
  if (warning === 'lowTexture') return 'Low texture';
  return 'Directional blur risk';
}

function formatAnalysisTimestamp(unixMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(unixMs));
}
