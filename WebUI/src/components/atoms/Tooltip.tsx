import React, { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom';
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children, position = 'bottom' }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();

      let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      let top = position === 'bottom'
        ? triggerRect.bottom + 8
        : triggerRect.top - tooltipRect.height - 8;

      // Keep tooltip within viewport
      if (left < 8) left = 8;
      if (left + tooltipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tooltipRect.width - 8;
      }

      setCoords({ left, top });
    }
  }, [isVisible, position]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        className="cursor-help"
      >
        {children}
      </span>
      {isVisible && (
        <div
          ref={tooltipRef}
          style={{
            position: 'fixed',
            left: coords.left,
            top: coords.top,
            zIndex: 9999,
          }}
          className="px-3 py-2 bg-gray-900 text-white text-xs font-mono rounded-lg shadow-lg max-w-md break-all"
        >
          {content}
          <div
            className={`absolute w-2 h-2 bg-gray-900 transform rotate-45 ${
              position === 'bottom'
                ? '-top-1 left-1/2 -translate-x-1/2'
                : '-bottom-1 left-1/2 -translate-x-1/2'
            }`}
          />
        </div>
      )}
    </>
  );
};
