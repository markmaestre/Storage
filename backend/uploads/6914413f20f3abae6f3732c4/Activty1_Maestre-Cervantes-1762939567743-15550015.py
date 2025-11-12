import math

print("=== Circle Area Computation Program ===")

radius_input = input("Please enter the radius of the circle: ")
radius = float(radius_input)

print("You entered the radius:", radius)

area = math.pi * (radius ** 2)

print("The formula used is: Area = π × radius²")
print("Step 1: Square the radius →", radius, "×", radius, "=", radius ** 2)
print("Step 2: Multiply by π (", math.pi, ") →", math.pi, "×", (radius ** 2))

print("=========================================")
print("The computed area of the circle is:", round(area, 2))
print("=========================================")
