import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/utils";

// Note: I'm not installing cva, I'll just manual class logic for now or quick-install it.
// Actually, using CVA is cleaner but I didn't install it. I'll use simple string maps or cn logic.
// Simulating CVA behavior for simplicity or I should install cva. 
// "class-variance-authority" is lightweight. I'll add it to next install batch if needed, but for now I'll just use simple props.

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    size?: "default" | "sm" | "lg" | "icon";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "default", size = "default", ...props }, ref) => {

        const variants = {
            default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
            destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm",
            outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
            secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
            ghost: "hover:bg-accent hover:text-accent-foreground",
            link: "text-primary underline-offset-4 hover:underline",
        };

        const sizes = {
            default: "h-10 px-4 py-2",
            sm: "h-9 rounded-md px-3",
            lg: "h-11 rounded-md px-8",
            icon: "h-10 w-10",
        };

        return (
            <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={cn(
                    "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
                    variants[variant],
                    sizes[size],
                    className
                )}
                ref={ref}
                {...props as any}
            />
        );
    }
);
Button.displayName = "Button";

export { Button };
