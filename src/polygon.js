const Apify = require('apify');
const turf = require('@turf/turf');
//const moment = require('moment');

const { log } = Apify.utils;
const TURF_UNIT = 'kilometers';

const GEO_TYPES = {
    MULTI_POLYGON: 'MultiPolygon',
    POLYGON: 'Polygon',
    POINT: 'Point',
    LINE_STRING: 'LineString'
};

const FEATURE_COLLECTION = 'FeatureCollection';
const FEATURE = 'Feature';

function checkInPolygon(geo, location) {
    const point = turf.point([location.lng, location.lat])
    let included = false;
    const polygons = getPolygons(geo.geojson);
    for (const polygon of polygons) {
        included = turf.booleanContains(polygon, point);
        if (included) break;
    }
    return included;
}

function getPolygons(geoJson, distanceKilometers = 5) {
    const { coordinates, type } = geoJson;
    if (type === GEO_TYPES.POLYGON) {
        return [turf.polygon(coordinates)];
    }

    if (type === FEATURE && geoJson.geometry.type === GEO_TYPES.POLYGON) {
        return [geoJson.geometry];
    }

    // We got only the point for city, lets create a circle...
    if (type === GEO_TYPES.POINT) {
        const options = { units: TURF_UNIT };
        return [turf.circle(coordinates, distanceKilometers, options)]
    }

    // Line (road or street) - find midpoint and length and create circle
    if (type === GEO_TYPES.LINE_STRING) {
        const options = { units: TURF_UNIT };

        const firstPoint = turf.point(coordinates[0]);
        const lastPoint = turf.point(coordinates[coordinates.length - 1]);
        const midPoint = turf.midpoint(firstPoint, lastPoint);

        const line = turf.lineString(coordinates);
        const length = turf.length(line, options);

        return [turf.circle(midPoint, length, options)];
    }

    // Multipolygon
    return coordinates.map((coords) => turf.polygon(coords));
}

async function getGeolocation(options) {
    const { city, state, country } = options;
    const cityString = (city || '').trim().replace(/\s+/g, '+');
    const stateString = (state || '').trim().replace(/\s+/g, '+');
    const countryString = (country || '').trim().replace(/\s+/g, '+');

    // TODO when get more results? Currently only first match is returned!
    const res = await Apify.utils.requestAsBrowser({
        url: encodeURI(`https://nominatim.openstreetmap.org/search?country=${countryString}&state=${stateString}&city=${cityString}&format=json&polygon_geojson=1&limit=1&polygon_threshold=0.005`),
        headers: { referer: "http://google.com" }
    })
    const body = JSON.parse(res.body);
    if (res.body) return body[0];
    return {};
}

/**
 * Calculates distance meters per pixel for zoom and latitude.
 */
function distanceByZoom(lat, zoom) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
}

/**
 *  Prepare centre points grid for search
 * @param location - GeoJSON
 * @param zoom
 * @param points
 * @returns {Promise<*[]|*>} Array of points
 */
async function findPointsInPolygon(location, zoom, points) {
    const { geojson } = location;
    const { coordinates, type } = geojson;
    if (!coordinates && ![FEATURE_COLLECTION, FEATURE].includes(type)) return [];

    // If we have a point add it to result
    if (type === GEO_TYPES.POINT) {
        const [lon, lat] = coordinates;
        points.push({ lon, lat });
    }
    // If we have a line add a first and last point
    if (type === GEO_TYPES.LINE_STRING) {
        const pointsToProcess = [coordinates[0], coordinates[coordinates.length - 1]];
        pointsToProcess.forEach((point) => {
            const [lon, lat] = point;
            points.push({ lon, lat });
        });
    }
    try {
        const polygons = getPolygons(geojson, 5);
        polygons.forEach((polygon) => {
            const bbox = turf.bbox(polygon);
            // distance in meters per pixel * viewport / 1000 meters
            let distanceKilometers = distanceByZoom(bbox[3], zoom) * 800 / 1000;
            // Creates grid of points inside given polygon
            let pointGrid;
            // point grid can be empty for to large distance.
            while (distanceKilometers > 0) {
                log.debug(distanceKilometers);
                // Use lower distance for points
                const distance = geojson.type === GEO_TYPES.POINT ? distanceKilometers / 2 : distanceKilometers;
                const options = {
                    units: 'kilometers',
                    mask: polygon,
                };
                pointGrid = turf.pointGrid(bbox, distance, options);

                if (pointGrid.features && pointGrid.features.length > 0) break;
                distanceKilometers = distanceKilometers - 1;
            }
            pointGrid.features.forEach((feature) => {
                const [lon, lat] = feature.geometry.coordinates;
                points.push({ lon, lat });
                //points.push(feature); // http://geojson.io is nice tool to check found points on map
            });
        });
    } catch (e) {
        log.exception(e, 'Failed to create point grid');
    }
    return points;
}

exports.getGeolocation = getGeolocation;
exports.checkInPolygon = checkInPolygon;
exports.findPointsInPolygon = findPointsInPolygon;
