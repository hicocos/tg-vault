import * as React from "react";
import { cn } from "../../lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "default" | "destructive" | "destructive-outline" | "outline" | "secondary" | "ghost" | "link";
    size?: "default" | "sm" | "lg" | "icon";
}

const variants = {
    default: "tv-btn-primary",
    destructive: "tv-btn-destructive",
    "destructive-outline": "tv-btn-outline tv-btn-danger",
    outline: "tv-btn-outline",
    secondary: "tv-btn-secondary",
    ghost: "tv-btn-ghost",
    link: "tv-btn-link",
};
const sizes = { default: "", sm: "tv-btn-sm", lg: "tv-btn-lg", icon: "tv-btn-icon" };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "default", size = "default", type, ...props }, ref) => (
        <button
            type={type}
            className={cn("tv-btn", variants[variant], sizes[size], className)}
            ref={ref}
            {...props}
        />
    )
);
Button.displayName = "Button";
export { Button };
