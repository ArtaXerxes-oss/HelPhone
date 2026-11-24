import ClusteredMapLayer from "./ClusteredMapLayer.jsx";

// The community map can show live incident points. When `points` is supplied
// it renders clustered markers (ADR-008) instead of raw pins; the static SVG
// below remains the decorative base map.
export default function CommunityMap({
  points = null,
  viewState = { longitude: 0, latitude: 20, zoom: 2 },
  width = 1140,
  height = 540,
  onMarkerClick,
  ...clusterOptions
} = {}) {
  return (
    <div style={{ position: "relative", width: "100%" }}>
    <svg
      viewBox="0 0 1140 540"
      style={{
        display: "block",
        width: "100%",
        height: "auto",
      }}
    >
      <defs>
        <pattern
          id="mdgrid"
          width="48"
          height="48"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M48 0H0V48"
            fill="none"
            stroke="#B9AE9C"
            strokeWidth="1"
            opacity="0.5"
          />
        </pattern>
      </defs>
      <rect width="1140" height="540" fill="#E7DAC2" />
      <rect width="1140" height="540" fill="url(#mdgrid)" />

      {/* Organic blobs */}
      <path
        d="M120 120 Q260 70 430 130 T720 150 Q620 280 700 360 Q500 430 360 380 Q200 410 150 300 Z"
        fill="#3F8487"
        opacity="0.07"
      />
      <path
        d="M760 90 Q940 110 1010 230 Q1060 360 920 430 Q820 470 770 360 Q820 240 740 190 Z"
        fill="#7357FF"
        opacity="0.06"
      />

      {/* Roads */}
      <path
        d="M0 200 Q300 160 560 240 T1140 210"
        fill="none"
        stroke="#B9AE9C"
        strokeWidth="3"
        opacity="0.7"
      />
      <path
        d="M180 0 Q230 220 360 320 T520 540"
        fill="none"
        stroke="#B9AE9C"
        strokeWidth="3"
        opacity="0.7"
      />
      <path
        d="M1140 380 Q860 350 700 400 T300 470"
        fill="none"
        stroke="#B9AE9C"
        strokeWidth="2.5"
        opacity="0.6"
      />
      <path
        d="M860 0 Q900 180 1000 280"
        fill="none"
        stroke="#B9AE9C"
        strokeWidth="2.5"
        opacity="0.6"
      />

      {/* Active routes */}
      <path
        d="M560 300 Q470 230 360 210"
        fill="none"
        stroke="#3F8487"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="9 11"
        style={{ animation: "mddash 1.4s linear infinite" }}
      />
      <path
        d="M560 300 Q700 280 820 200"
        fill="none"
        stroke="#7357FF"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="9 11"
        style={{ animation: "mddash 1.7s linear infinite" }}
      />
      <path
        d="M560 300 Q620 400 760 420"
        fill="none"
        stroke="#FF7A6B"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="9 11"
        style={{ animation: "mddash 1.2s linear infinite" }}
      />

      {/* Responder pins */}
      <g>
        <circle cx="360" cy="210" r="9" fill="#3F8487" opacity="0.35">
          <animate
            attributeName="r"
            values="9;26;9"
            dur="3.2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.4;0;0.4"
            dur="3.2s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="360"
          cy="210"
          r="7"
          fill="#3F8487"
          stroke="#ECE0CC"
          strokeWidth="2.5"
        />
      </g>
      <g>
        <circle cx="820" cy="200" r="9" fill="#7357FF" opacity="0.35">
          <animate
            attributeName="r"
            values="9;24;9"
            dur="3.6s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.4;0;0.4"
            dur="3.6s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="820"
          cy="200"
          r="7"
          fill="#7357FF"
          stroke="#ECE0CC"
          strokeWidth="2.5"
        />
      </g>
      <g>
        <circle cx="760" cy="420" r="9" fill="#FF7A6B" opacity="0.35">
          <animate
            attributeName="r"
            values="9;24;9"
            dur="2.8s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.4;0;0.4"
            dur="2.8s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="760"
          cy="420"
          r="7"
          fill="#FF7A6B"
          stroke="#ECE0CC"
          strokeWidth="2.5"
        />
      </g>

      {/* Central request pin */}
      <g>
        <circle cx="560" cy="300" r="14" fill="#FF7A6B" opacity="0.3">
          <animate
            attributeName="r"
            values="14;40;14"
            dur="2.4s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.5;0;0.5"
            dur="2.4s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="560"
          cy="300"
          r="13"
          fill="#234B4E"
          stroke="#ECE0CC"
          strokeWidth="3"
        />
        <circle cx="560" cy="300" r="4.5" fill="#FF7A6B" />
      </g>
      <text
        x="560"
        y="268"
        textAnchor="middle"
        fontFamily="VT323, monospace"
        fontSize="18"
        fill="#234B4E"
      >
        REQUEST 04:12
      </text>
    </svg>
    {points && (
      <ClusteredMapLayer
        points={points}
        viewState={viewState}
        width={width}
        height={height}
        onMarkerClick={onMarkerClick}
        style={{ position: "absolute", inset: 0, pointerEvents: onMarkerClick ? "auto" : "none" }}
        {...clusterOptions}
      />
    )}
    </div>
  );
}
