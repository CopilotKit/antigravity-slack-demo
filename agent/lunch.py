"""The lunch catalogue, as backend tools on the Antigravity agent.

These are ordinary Python functions handed to ``AntigravityAgent(tools=...)``.
The adapter derives each tool's schema from the signature, so the annotations
and docstrings here are the contract the model sees -- they are not decoration.

**This data is invented.** There is no self-serve API anywhere that lets a
third party browse restaurant menus and order on a customer's behalf: the
marketplace APIs are merchant-facing and partner-gated, and the one sanctioned
route to consumer ordering, DoorDash's ``dd-cli``, is a waitlisted macOS binary
driven over a shell rather than an API. So the catalogue is a fixture, and the
restaurants are fictional on purpose -- putting a real business's name on
orders it never agreed to serve is not a demo, it is a misrepresentation.

Swapping this for something real means replacing these three functions and
nothing else: the channel renders whatever they return.

Prices are integer cents throughout. Money in floats invites a rounding bug
that only shows up once someone orders three of something.
"""

from __future__ import annotations

from typing import Any, Dict, List

# Served from this repo rather than hotlinked. Slack fetches image URLs
# server-side and a fetch it cannot complete is a non-retryable delivery
# failure that aborts the run, so the demo should not ride on a third party's
# User-Agent policy. See assets/food/CREDITS.md for attribution.
IMAGE_BASE = (
    "https://raw.githubusercontent.com/CopilotKit/antigravity-slack-demo"
    "/main/assets/food"
)


def _img(slug: str) -> str:
    return f"{IMAGE_BASE}/{slug}.jpg"


_RESTAURANTS: List[Dict[str, Any]] = [
    {
        "id": "bangkok-kitchen",
        "name": "Bangkok Kitchen",
        "cuisine": "Thai",
        "price_range": "$$",
        "eta_minutes": 30,
        "rating": 4.6,
        "blurb": (
            "Wok noodles and curries, heavy on the vegetarian options. "
            "The pad thai is the one people re-order."
        ),
        "image": _img("pad-thai"),
        "tags": ["vegetarian-friendly", "spicy"],
    },
    {
        "id": "nonna-rosa",
        "name": "Nonna Rosa",
        "cuisine": "Italian",
        "price_range": "$$",
        "eta_minutes": 40,
        "rating": 4.4,
        "blurb": (
            "Handmade pasta and blistered pizza. Slowest of the four, and "
            "the one nobody complains about."
        ),
        "image": _img("lasagne"),
        "tags": ["comfort", "shareable"],
    },
    {
        "id": "ballard-burger",
        "name": "Ballard Burger Co",
        "cuisine": "Burgers",
        "price_range": "$",
        "eta_minutes": 20,
        "rating": 4.2,
        "blurb": (
            "Smashburgers and fries. Fastest option by a wide margin -- "
            "pick this when lunch is already late."
        ),
        "image": _img("cheeseburger"),
        "tags": ["fast", "cheap"],
    },
    {
        "id": "emerald-greens",
        "name": "Emerald Greens",
        "cuisine": "Salads & bowls",
        "price_range": "$$",
        "eta_minutes": 25,
        "rating": 4.5,
        "blurb": (
            "Big salads, grain bowls and wraps. The default when the office "
            "has had fried food two days running."
        ),
        "image": _img("poke"),
        "tags": ["healthy", "vegan-options", "gluten-free-options"],
    },
]

_MENUS: Dict[str, List[Dict[str, Any]]] = {
    "bangkok-kitchen": [
        {"id": "bk-pad-thai", "name": "Pad Thai", "price_cents": 1650,
         "description": "Rice noodles, egg, peanuts, tamarind. Chicken, tofu or prawn.",
         "image": _img("pad-thai"), "tags": ["vegetarian-option"]},
        {"id": "bk-green-curry", "name": "Green Curry", "price_cents": 1750,
         "description": "Coconut, Thai basil, bamboo. Medium heat, served with rice.",
         "image": _img("green-curry"), "tags": ["spicy", "gluten-free"]},
        {"id": "bk-tom-yum", "name": "Tom Yum Soup", "price_cents": 1100,
         "description": "Hot and sour lemongrass broth with mushrooms and prawns.",
         "image": _img("tom-yum"), "tags": ["spicy"]},
        {"id": "bk-spring-rolls", "name": "Spring Rolls (4)", "price_cents": 850,
         "description": "Crisp vegetable rolls with sweet chilli. Good for sharing.",
         "image": _img("spring-rolls"), "tags": ["vegetarian", "shareable"]},
    ],
    "nonna-rosa": [
        {"id": "nr-lasagne", "name": "Lasagne al Forno", "price_cents": 1900,
         "description": "Beef and pork ragu, bechamel, baked until the edges catch.",
         "image": _img("lasagne"), "tags": []},
        {"id": "nr-carbonara", "name": "Spaghetti Carbonara", "price_cents": 1750,
         "description": "Guanciale, pecorino, egg yolk. No cream, before anyone asks.",
         "image": _img("carbonara"), "tags": []},
        {"id": "nr-margherita", "name": "Pizza Margherita", "price_cents": 1600,
         "description": "San Marzano, fior di latte, basil. Twelve inch.",
         "image": _img("margherita"), "tags": ["vegetarian"]},
        {"id": "nr-caprese", "name": "Caprese Salad", "price_cents": 1200,
         "description": "Tomato, mozzarella, basil, olive oil. Light side or small lunch.",
         "image": _img("caprese"), "tags": ["vegetarian", "gluten-free"]},
    ],
    "ballard-burger": [
        {"id": "bb-cheeseburger", "name": "Double Cheeseburger", "price_cents": 1400,
         "description": "Two smashed patties, American cheese, pickles, house sauce.",
         "image": _img("cheeseburger"), "tags": []},
        {"id": "bb-chicken", "name": "Fried Chicken Sandwich", "price_cents": 1450,
         "description": "Buttermilk chicken thigh, slaw, hot honey on a potato bun.",
         "image": _img("chicken-sando"), "tags": ["spicy"]},
        {"id": "bb-fries", "name": "Fries", "price_cents": 550,
         "description": "Skin-on, salted. Order one more than you think.",
         "image": _img("fries"), "tags": ["vegetarian", "shareable"]},
        {"id": "bb-shake", "name": "Milkshake", "price_cents": 700,
         "description": "Vanilla, chocolate or strawberry. Thick enough to hold a straw.",
         "image": _img("milkshake"), "tags": ["vegetarian"]},
    ],
    "emerald-greens": [
        {"id": "eg-caesar", "name": "Chicken Caesar", "price_cents": 1500,
         "description": "Romaine, grilled chicken, parmesan, sourdough croutons.",
         "image": _img("caesar"), "tags": []},
        {"id": "eg-cobb", "name": "Cobb Salad", "price_cents": 1600,
         "description": "Egg, avocado, bacon, blue cheese. Substantial, not a side.",
         "image": _img("cobb"), "tags": ["gluten-free"]},
        {"id": "eg-poke", "name": "Salmon Poke Bowl", "price_cents": 1800,
         "description": "Raw salmon, sushi rice, edamame, cucumber, sesame.",
         "image": _img("poke"), "tags": ["gluten-free"]},
        {"id": "eg-falafel", "name": "Falafel Wrap", "price_cents": 1300,
         "description": "Falafel, hummus, pickled veg, tahini in a warm flatbread.",
         "image": _img("falafel"), "tags": ["vegan"]},
    ],
}

# Deliberately dated relative to nothing: the model should treat these as "the
# last few times we ordered", not compute dates from them.
_HISTORY: List[Dict[str, Any]] = [
    {"when": "last Thursday", "restaurant": "Ballard Burger Co",
     "items": ["4x Double Cheeseburger", "3x Fries", "1x Milkshake"],
     "total_cents": 8050, "people": 5},
    {"when": "last Tuesday", "restaurant": "Emerald Greens",
     "items": ["2x Cobb Salad", "2x Falafel Wrap", "1x Salmon Poke Bowl"],
     "total_cents": 7600, "people": 5},
    {"when": "two weeks ago, Friday", "restaurant": "Bangkok Kitchen",
     "items": ["3x Pad Thai", "2x Green Curry", "2x Spring Rolls (4)"],
     "total_cents": 10100, "people": 6},
    {"when": "two weeks ago, Wednesday", "restaurant": "Nonna Rosa",
     "items": ["2x Lasagne al Forno", "2x Pizza Margherita", "1x Caprese Salad"],
     "total_cents": 8200, "people": 4},
    {"when": "three weeks ago, Monday", "restaurant": "Ballard Burger Co",
     "items": ["3x Fried Chicken Sandwich", "2x Fries"],
     "total_cents": 5450, "people": 4},
]


def search_restaurants(query: str = "") -> List[Dict[str, Any]]:
    """Find restaurants the office can order lunch from.

    ALWAYS follow this with the show_restaurants tool, passing these results
    through unchanged. Listing the restaurants as text instead is wrong: the
    people reading are picking lunch in Slack, and a bulleted list gives them
    no photos, no prices and nothing to click. Add your own recommendation in
    words on top of the cards -- that part is yours, the listing is not.

    Args:
      query: Free text to filter on, matched against name, cuisine, blurb and
        tags -- for example "thai", "fast", "vegan", "cheap". Leave empty to
        get all four restaurants.
    """
    needle = query.strip().lower()
    if not needle:
        return [dict(r) for r in _RESTAURANTS]

    def matches(r: Dict[str, Any]) -> bool:
        hay = " ".join(
            [r["name"], r["cuisine"], r["blurb"], " ".join(r["tags"]), r["price_range"]]
        ).lower()
        # Any word hitting is enough: "fast thai" should not require both.
        return any(word in hay for word in needle.split())

    hits = [dict(r) for r in _RESTAURANTS if matches(r)]
    # Never strand the model with nothing to show; it can explain the miss.
    return hits or [dict(r) for r in _RESTAURANTS]


def get_menu(restaurant_id: str) -> Dict[str, Any]:
    """Get the full menu for one restaurant.

    Pass the result to the show_menu tool so people can add items by clicking.

    Args:
      restaurant_id: The `id` from search_restaurants, e.g. "bangkok-kitchen".
    """
    key = restaurant_id.strip().lower()
    restaurant = next((r for r in _RESTAURANTS if r["id"] == key), None)
    if restaurant is None:
        known = ", ".join(r["id"] for r in _RESTAURANTS)
        return {
            "error": f"No restaurant with id {restaurant_id!r}. Known ids: {known}.",
            "restaurant": None,
            "items": [],
        }
    return {
        "error": None,
        "restaurant": dict(restaurant),
        "items": [dict(i) for i in _MENUS[key]],
    }


def get_order_history(limit: int = 5) -> List[Dict[str, Any]]:
    """Look up what the office ordered on previous days.

    Use this to answer "what did we get last time", to avoid repeating
    yesterday's cuisine, or to suggest something the team already likes.

    Args:
      limit: How many past orders to return, most recent first. Max 5.
    """
    return [dict(o) for o in _HISTORY[: max(1, min(limit, len(_HISTORY)))]]


LUNCH_TOOLS = [search_restaurants, get_menu, get_order_history]
