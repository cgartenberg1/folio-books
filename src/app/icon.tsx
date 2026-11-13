import { ImageResponse } from 'next/og';

export const size = {
  width: 512,
  height: 512,
};
export const contentType = 'image/png';

/** A cloth-bound book board: oxblood buckram with a gilt-stamped italic F. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#6E1F24',
          borderRadius: '96px',
        }}
      >
        <div
          style={{
            width: '78%',
            height: '78%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '6px solid rgba(226, 197, 142, 0.55)',
            borderRadius: '28px',
            color: '#E2C58E',
            fontSize: 300,
            fontFamily: 'Georgia, serif',
            fontStyle: 'italic',
            paddingBottom: 24,
          }}
        >
          F
        </div>
      </div>
    ),
    { ...size }
  );
}
