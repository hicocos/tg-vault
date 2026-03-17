import { useCallback, useRef, useState } from 'react';

interface LongPressOptions {
  threshold?: number;
  onLongPress?: (e: any) => void;
  onClick?: (e: any) => void;
}

export const useLongPress = ({
  threshold = 500,
  onLongPress,
  onClick,
}: LongPressOptions = {}) => {
  const [longPressTriggered, setLongPressTriggered] = useState(false);
  const timeoutRef = useRef<any>(null);
  const targetRef = useRef<any>(null);

  const start = useCallback(
    (event: any) => {
      if (event.target) {
        targetRef.current = event.target;
      }
      
      setLongPressTriggered(false);
      timeoutRef.current = setTimeout(() => {
        onLongPress?.(event);
        setLongPressTriggered(true);
      }, threshold);
    },
    [onLongPress, threshold]
  );

  const clear = useCallback(
    (event: any, shouldTriggerClick = true) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      
      if (shouldTriggerClick && !longPressTriggered) {
        onClick?.(event);
      }
      
      setLongPressTriggered(false);
    },
    [onClick, longPressTriggered]
  );

  return {
    onMouseDown: (e: any) => start(e),
    onMouseUp: (e: any) => clear(e),
    onMouseLeave: (e: any) => clear(e, false),
    onTouchStart: (e: any) => start(e),
    onTouchEnd: (e: any) => clear(e),
  };
};
