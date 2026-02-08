import React from 'react';
import { TIME_RANGE_OPTIONS, TimeRangeOption } from '../../types';

interface TimeRangeSelectorProps {
  value: string;
  onChange: (option: TimeRangeOption) => void;
}

export const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({ value, onChange }) => {
  return (
    <div className="inline-flex rounded-full bg-bg-surface p-1 gap-1">
      {TIME_RANGE_OPTIONS.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option)}
            className={`
              px-3 py-1 text-sm font-medium rounded-full transition-all duration-150
              ${isActive
                ? 'bg-accent text-white shadow-pill'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-surface2'
              }
            `}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
