import { ImageResponse } from 'next/og';

export const size = {
  width: 180,
  height: 180,
};
export const contentType = 'image/png';

/** Home-screen icon: oxblood buckram board with a gilt italic F (iOS applies its own corner mask). */
export default function AppleIcon() {
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
        }}
      >
        <div
          style={{
            width: '76%',
            height: '76%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid rgba(226, 197, 142, 0.55)',
            borderRadius: '10px',
            color: '#E2C58E',
            fontSize: 104,
            fontFamily: 'Georgia, serif',
            fontStyle: 'italic',
            paddingBottom: 8,
          }}
        >
          F
        </div>
      </div>
    ),
    { ...size }
  );
}
